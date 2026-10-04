// Gathers every package's HTML coverage report into one folder with an index
// page. The index states the commit and the date it was built from, because a
// published report keeps serving the last commit that built it.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { CoverageConfig } from "./config.mts";
import { METRICS } from "./config.mts";
import type { PackageResult } from "./judge.mts";
import { REPORTS_DIRECTORY, TEST_RESULTS_FILE } from "./measure.mts";
import type { Build } from "./report.mts";
import { describeBar, describeBuild, describeShortfall, formatTotal } from "./report.mts";

/** The merged report, from the project root. Under `coverage/`, which the starter ignores. */
export const REPORT_DIRECTORY = "coverage/report";
/** Each package's vitest JSON test report, from the project root. Not part of the published report. */
export const TEST_REPORT_DIRECTORY = "coverage/test-results";

export interface ReportOptions {
  root: string;
  results: PackageResult[];
  config: CoverageConfig;
  build: Build;
}

/** Writes the merged report and returns the path of its index page, from the project root. */
export function buildReport({ root, results, config, build }: ReportOptions): string {
  const report = join(root, REPORT_DIRECTORY);
  const testReports = join(root, TEST_REPORT_DIRECTORY);

  rmSync(report, { recursive: true, force: true });
  rmSync(testReports, { recursive: true, force: true });
  mkdirSync(report, { recursive: true });

  const browsable = new Set<string>();

  for (const { directory, measured } of results) {
    const packageReports = join(root, directory, REPORTS_DIRECTORY);

    if (measured.length > 0 && existsSync(join(packageReports, "index.html"))) {
      cpSync(packageReports, join(report, directory), {
        recursive: true,
        filter: (source) => basename(source) !== TEST_RESULTS_FILE,
      });
      browsable.add(directory);
    }

    if (existsSync(join(packageReports, TEST_RESULTS_FILE))) {
      const copy = join(testReports, `${directory}.json`);

      mkdirSync(dirname(copy), { recursive: true });
      cpSync(join(packageReports, TEST_RESULTS_FILE), copy);
    }
  }

  writeFileSync(join(report, "index.html"), renderIndex(results, config, build, browsable));
  writeFileSync(join(report, "summary.json"), `${JSON.stringify(summarise(results, config, build), null, 2)}\n`);

  return `${REPORT_DIRECTORY}/index.html`;
}

export function renderIndex(results: PackageResult[], { thresholds, exclude }: CoverageConfig, build: Build, browsable: Set<string>): string {
  const rows = results.map((result) => {
    const name = escapeHtml(result.directory);
    const link = browsable.has(result.directory) ? `<a href="./${name}/index.html">${name}</a>` : name;
    const totals = METRICS.map((metric) => `<td class="number">${formatTotal(result.measured, metric)}</td>`).join("");

    return `      <tr><td>${link}</td><td class="${result.verdict.toLowerCase()}">${result.verdict}</td><td>${escapeHtml(result.reason)}</td>${totals}</tr>`;
  });
  const underTheBar = results
    .flatMap((result) => result.underTheBar)
    .map(({ file, shortfalls }) => `      <li><code>${escapeHtml(file)}</code> — ${escapeHtml(shortfalls.map(describeShortfall).join(" · "))}</li>`);
  const ignores = results
    .flatMap((result) => result.unexplainedIgnores)
    .map(({ file, line }) => `      <li><code>${escapeHtml(file)}:${line}</code> — an ignore comment without a reason</li>`);
  const leftOut = Object.entries(exclude).map(
    ([pattern, reason]) => `      <li><code>${escapeHtml(pattern)}</code> — ${escapeHtml(reason)}</li>`,
  );
  const run = build.runUrl === undefined ? "" : `\n    <p><a href="${escapeHtml(build.runUrl)}">The run that built this report</a></p>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Coverage report</title>
    <style>
      :root { color-scheme: light dark; }
      body { font: 16px/1.5 system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
      table { border-collapse: collapse; width: 100%; }
      th, td { text-align: left; padding: .3rem .6rem; border-bottom: 1px solid #8884; }
      .number { text-align: right; font-variant-numeric: tabular-nums; }
      .pass { color: #1a7f37; } .fail, .error { color: #cf222e; } .skip { color: #9a6700; }
      .build { font-weight: 600; }
    </style>
  </head>
  <body>
    <h1>Coverage report</h1>
    <p class="build">Built from ${escapeHtml(describeBuild(build))}.</p>
    <p>A published report shows the commit that built it, not the newest one. Compare the commit above with the code you are reading before you trust a number here.</p>
    <p>The bar, for every file: ${escapeHtml(describeBar(thresholds))}.</p>
    <table>
      <tr><th>Package</th><th>Verdict</th><th>Why</th>${METRICS.map((metric) => `<th class="number">${metric}</th>`).join("")}</tr>
${rows.join("\n")}
    </table>
    <h2>Findings</h2>
${underTheBar.length + ignores.length === 0 ? "    <p>None.</p>" : `    <ul>\n${[...underTheBar, ...ignores].join("\n")}\n    </ul>`}
    <h2>Left out of the measurement</h2>
${leftOut.length === 0 ? "    <p>Nothing.</p>" : `    <ul>\n${leftOut.join("\n")}\n    </ul>`}${run}
  </body>
</html>
`;
}

function summarise(results: PackageResult[], { thresholds, exclude }: CoverageConfig, build: Build): object {
  return {
    commit: build.commit ?? null,
    uncommittedChanges: build.dirty,
    ref: build.ref ?? null,
    builtAt: build.builtAt.toISOString(),
    thresholds,
    exclude,
    packages: results.map(({ directory, verdict, reason, measured, emptyFiles, underTheBar, unexplainedIgnores, failedTests }) => ({
      directory,
      verdict,
      reason,
      measuredFiles: measured.length,
      emptyFiles,
      underTheBar,
      unexplainedIgnores,
      failedTests,
    })),
  };
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
