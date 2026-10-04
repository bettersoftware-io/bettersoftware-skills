#!/usr/bin/env node
// The runtime motion audit: what is actually animating in the running client,
// and whether the compositor can run it.
//
//   node tools/perf/motion-audit.mts                  audit the only client, at /
//   node tools/perf/motion-audit.mts --path /orders   audit another route (repeatable)
//   node tools/perf/motion-audit.mts --seconds 10     a longer sampling window (default 4)
//   node tools/perf/motion-audit.mts --assert-still   fail on anything that moves under reduced motion
//   node tools/perf/motion-audit.mts --client packages/client-react --root <dir>
//
// It builds the client for the in-browser simulator, serves that build on a
// free port, opens it in Chromium, and takes a census twice: once as it is,
// once with `prefers-reduced-motion: reduce`. See docs/performance.md.
//
// Exit 0: every animation seen is compositor-only, or none was seen (SKIP).
// Exit 1: findings. Exit 2: the audit could not run.

import { resolve } from "node:path";

import { AllowedError, type AllowedMotion, loadAllowed } from "./lib/allowed.mts";
import { isMainModule } from "./lib/files.mts";
import { describeAnimation, judgeMotion, type MotionVerdict, readTracedFailures } from "./lib/motion-judge.mts";
import { type MotionSample, sampleMotion } from "./lib/motion-probe.mts";
import { type ClientServer, findClient, ServerError, startClient } from "./lib/server.mts";

type Playwright = typeof import("playwright");
type Browser = Awaited<ReturnType<Playwright["chromium"]["launch"]>>;

const GATE = "motion-audit";
const SNAPSHOT_INTERVAL_MS = 50;

class AuditError extends Error {}

interface AuditOptions {
  root: string;
  client?: string;
  paths: string[];
  seconds: number;
  settleSeconds: number;
  assertStill: boolean;
}

interface Pass {
  path: string;
  reducedMotion: boolean;
  sample: MotionSample;
  verdict: MotionVerdict;
  /** Lines the app logged that start with `[data]`: which data source it composed. */
  dataSource: string[];
}

async function audit(options: AuditOptions): Promise<number> {
  const allowed = (await loadAllowed(options.root)).motion;
  const client = findClient(options.root, options.client);
  // The browser is started first: without one there is no point in building.
  const browser = await launchBrowser();
  let server: ClientServer | undefined;

  async function cleanUp(): Promise<void> {
    await browser.close().catch(() => undefined);
    await server?.stop();
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void cleanUp().finally(() => process.exit(130));
    });
  }

  try {
    server = await startClient(options.root, client);
    console.log(`${GATE}: ${client}, built for the simulator, served on ${server.url}`);

    const passes: Pass[] = [];

    for (const path of options.paths) {
      for (const reducedMotion of [false, true]) {
        passes.push(await runPass(browser, `${server.url}${path}`, path, reducedMotion, options, allowed));
      }
    }

    return report(passes, options);
  } finally {
    await cleanUp();
  }
}

async function launchBrowser(): Promise<Browser> {
  let playwright: Playwright;

  try {
    playwright = await import("playwright");
  } catch {
    throw new AuditError("the playwright package is not installed: run pnpm install");
  }

  try {
    return await playwright.chromium.launch();
  } catch (error) {
    const firstLine = (error instanceof Error ? error.message : String(error)).split("\n")[0];

    throw new AuditError(
      `Chromium could not be started (${firstLine}). Install the browser this Playwright version needs: pnpm exec playwright install chromium`,
    );
  }
}

async function runPass(
  browser: Browser,
  url: string,
  path: string,
  reducedMotion: boolean,
  options: AuditOptions,
  allowed: AllowedMotion[],
): Promise<Pass> {
  const context = await browser.newContext({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });

  try {
    const page = await context.newPage();
    const errors: string[] = [];
    const dataSource: string[] = [];

    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.text().startsWith("[data]")) {
        dataSource.push(message.text());
      }
    });

    // The trace starts before the page loads: Chromium says whether it could
    // composite an animation once, when the animation starts.
    await browser.startTracing(page, { categories: ["blink.animations"] });

    let sample: MotionSample;
    let trace: unknown;

    try {
      const response = await page.goto(url, { waitUntil: "load" });

      if (response === null || !response.ok()) {
        throw new AuditError(`${url} answered ${response?.status() ?? "nothing"}`);
      }

      // Let the page mount and its entry animations end, so that steady state
      // is what gets sampled.
      await page.waitForTimeout(options.settleSeconds * 1000);

      sample = await page.evaluate(sampleMotion, {
        samples: Math.max(2, Math.round((options.seconds * 1000) / SNAPSHOT_INTERVAL_MS)),
        intervalMs: SNAPSHOT_INTERVAL_MS,
      });
    } finally {
      trace = JSON.parse((await browser.stopTracing()).toString());
    }

    if (errors.length > 0) {
      // A page that crashed shows no animation. That is not a clean result.
      throw new AuditError(`the page threw an error, so there is nothing to trust in its census: ${errors[0]}`);
    }

    const verdict = judgeMotion({
      sample,
      traced: readTracedFailures(trace),
      allowed,
      mustBeStill: reducedMotion && options.assertStill,
    });

    return { path, reducedMotion, sample, verdict, dataSource };
  } finally {
    await context.close();
  }
}

function report(passes: Pass[], options: AuditOptions): number {
  const dataSource = [...new Set(passes.flatMap((pass) => pass.dataSource))];
  const chromiumVerdict = passes.every((pass) => pass.verdict.chromiumVerdict);
  let findings = 0;
  let accepted = 0;
  let seen = 0;

  for (const line of dataSource) {
    console.log(`  the app logged: ${line}`);
  }

  for (const { path, reducedMotion, sample, verdict } of passes) {
    const perSecond = sample.elapsedMs > 0 ? Math.round((sample.rafCallbacks / sample.elapsedMs) * 1000) : 0;
    const mode = reducedMotion
      ? `prefers-reduced-motion: reduce, what still moves${options.assertStill ? " (must be nothing)" : " (reported, not failed)"}`
      : "motion allowed";

    console.log(
      `\n${path} · ${mode} · ${(sample.elapsedMs / 1000).toFixed(1)} s, ${sample.samples} snapshots, ${perSecond} animation-frame callback(s) per second`,
    );

    if (sample.animations.length === 0) {
      console.log("  no animation was alive");
    }

    for (const animation of sample.animations) {
      console.log(`  ${describeAnimation(animation, sample.samples)}`);
    }

    for (const finding of verdict.findings) {
      console.log(`  FAIL ${finding.animation} on ${finding.target}\n    ${finding.message}`);
    }

    for (const { animation, target, reason } of verdict.accepted) {
      console.log(`  accepted ${animation} on ${target}: ${reason}`);
    }

    findings += verdict.findings.length;
    accepted += verdict.accepted.length;
    seen += sample.animations.length;
  }

  console.log("");

  if (!chromiumVerdict) {
    console.log(
      "NOTE Chromium's own verdict was not used: this browser has compositor animations switched off, so its trace fails every animation. Judged by property only.\n",
    );
  }

  if (findings > 0) {
    console.log(
      [
        `FAIL ${GATE} (${findings}). Fix the animation; docs/performance.md has a pattern for each case.`,
        "An exception is accepted only in tools/perf/allowed.mts, under `motion`, as { animation, reason }.",
      ].join("\n"),
    );

    return 1;
  }

  if (seen === 0) {
    // Nothing to judge is reported as such: it is not a pass.
    console.log(
      `SKIP ${GATE} — no animation was alive in any ${options.seconds} s window on ${options.paths.join(", ")}. A view behind a click, or motion that needs a pointer, is not reached.`,
    );

    return 0;
  }

  console.log(
    accepted === 0
      ? `PASS ${GATE} — ${seen} animation(s) seen alive over ${passes.length} pass(es), each on \`transform\` or \`opacity\` only${chromiumVerdict ? " and composited by Chromium" : ""}`
      : `PASS ${GATE} — ${seen} animation(s) seen alive over ${passes.length} pass(es); ${accepted} finding(s) accepted by tools/perf/allowed.mts, nothing else failed`,
  );

  return 0;
}

function parseArguments(argv: string[]): AuditOptions {
  const options: AuditOptions = { root: process.cwd(), paths: [], seconds: 4, settleSeconds: 2, assertStill: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];

    if (argument === "--") {
      // pnpm passes the separator of `pnpm run script -- --flag` through.
      continue;
    }

    if (argument === "--assert-still") {
      options.assertStill = true;
      continue;
    }

    if (value === undefined) {
      throw new AuditError(`"${argument}" needs a value`);
    }

    if (argument === "--root") {
      options.root = value;
    } else if (argument === "--client") {
      options.client = value;
    } else if (argument === "--path") {
      options.paths.push(value.startsWith("/") ? value : `/${value}`);
    } else if (argument === "--seconds" || argument === "--settle") {
      const seconds = Number.parseFloat(value);

      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new AuditError(`"${argument}" needs a number of seconds above 0`);
      }

      options[argument === "--seconds" ? "seconds" : "settleSeconds"] = seconds;
    } else {
      throw new AuditError(`unknown argument "${argument}" (use --path, --seconds, --settle, --assert-still, --client, --root)`);
    }

    index += 1;
  }

  return { ...options, root: resolve(options.root), paths: options.paths.length === 0 ? ["/"] : options.paths };
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = await audit(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(
      error instanceof AuditError || error instanceof ServerError || error instanceof AllowedError
        ? `${GATE} could not run: ${error.message}`
        : error,
    );
    process.exitCode = 2;
  }
}
