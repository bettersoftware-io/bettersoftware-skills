// The runner against real processes: fake programs that listen on real ports
// and start children of their own. Named *.port.test: it needs to open ports.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { createGroups, isGroupAlive, StartError } from "../files/tools/e2e/lib/processes.mts";
import { startMode } from "../files/tools/e2e/lib/stack.mts";
import { runCommand } from "../files/tools/e2e/run.mts";
import {
  createFakeProject,
  fileExists,
  findSurvivors,
  isPortFree,
  readBuilt,
  readRecord,
  readRunnerRecord,
  REAL_PROCESS_TIMEOUT,
  renderConfig,
  startCli,
  write,
} from "./support.mts";

describe("pnpm e2e, from start to end", { timeout: REAL_PROCESS_TIMEOUT }, () => {
  it("starts each mode's stack, runs the specs against them, and leaves nothing running", async () => {
    const project = createFakeProject();

    const { exitCode, output } = await startCli(project).ended;

    const runner = readRunnerRecord(project.record);
    const programs = readRecord(project.record);

    expect(output).toContain("[e2e] sim: client built and served at http://127.0.0.1:");
    expect(output).toContain("[e2e] fullstack: server ready at ws://127.0.0.1:");
    expect(exitCode).toBe(0);
    // Both clients answered at the address the runner was given, and the
    // full-stack one was told where its server is.
    expect(Object.keys(runner.modes)).toEqual(["sim", "fullstack"]);
    expect(runner.answers).toEqual({ sim: "client", fullstack: "client" });
    expect(runner.modes.sim?.serverURL).toBeUndefined();
    expect(runner.modes.sim?.serverHost).toBeUndefined();
    expect(runner.modes.fullstack?.serverURL).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
    expect(runner.modes.fullstack?.serverHost).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(runner.modes.sim?.baseURL).not.toBe(runner.modes.fullstack?.baseURL);
    // The specs run in the tests package, with Playwright's own command.
    expect(runner.cwd).toBe(join(project.root, "packages/e2e"));
    expect(runner.argv).toEqual(["test"]);
    // Three servers, each with a child, and the runner with its own.
    expect(Object.keys(programs)).toHaveLength(4);
    expect(findSurvivors(project.record)).toEqual([]);

    for (const { port } of Object.values(programs)) {
      expect(port === undefined || (await isPortFree(port))).toBe(true);
    }
  });

  it("builds each mode with its own variables: the address its server printed in one, none in the other", async () => {
    const project = createFakeProject();

    await startCli(project).ended;

    const [server] = Object.entries(readRecord(project.record)).flatMap(([name, { port }]) => (name.startsWith("server-") ? [port] : []));
    const address = `ws://127.0.0.1:${server}/ws`;

    expect(readBuilt(project.root, "sim")).toEqual({ serverUrl: "", apiUrl: "" });
    // Two variables from the one address the server printed: one as printed, one written around its host and port.
    expect(readBuilt(project.root, "fullstack")).toEqual({ serverUrl: address, apiUrl: `http://127.0.0.1:${server}/api` });
    expect(readRunnerRecord(project.record).modes.fullstack?.serverURL).toBe(address);
    expect(readRunnerRecord(project.record).modes.fullstack?.serverHost).toBe(`127.0.0.1:${server}`);
  });

  it("reads an address out of a line a program printed in colour", async () => {
    const project = createFakeProject();
    const bold = (text: string): string => `\u001b[1m${text}\u001b[22m`;
    const serve = project.config.client.serve.map((part) =>
      part.includes("Local:") ? `  \u001b[32m➜\u001b[39m  ${bold("Local")}:   \u001b[36mhttp://127.0.0.1:${bold("PORT")}/\u001b[39m` : part,
    );

    write(join(project.root, "tools/e2e.config.mts"), renderConfig({ ...project.config, client: { ...project.config.client, serve } }));

    const { exitCode } = await startCli(project, ["--mode", "sim"]).ended;

    expect(exitCode).toBe(0);
    expect(readRunnerRecord(project.record).modes.sim?.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("starts only what one mode needs, and passes the other arguments on", async () => {
    const project = createFakeProject();

    const { exitCode } = await startCli(project, ["--mode", "sim", "src/sim/list.spec.ts", "-g", "a title"]).ended;

    expect(exitCode).toBe(0);
    expect(Object.keys(readRunnerRecord(project.record).modes)).toEqual(["sim"]);
    expect(readRunnerRecord(project.record).argv).toEqual(["test", "src/sim/list.spec.ts", "-g", "a title"]);
    expect(Object.keys(readRecord(project.record)).filter((name) => name.startsWith("server-"))).toEqual([]);
  });

  it("exits with the test runner's code when a spec fails, and still leaves nothing running", async () => {
    const project = createFakeProject();

    const { exitCode } = await startCli(project, [], { FAKE_RUNNER: "fail" }).ended;

    expect(exitCode).toBe(1);
    expect(Object.keys(readRecord(project.record))).toHaveLength(4);
    expect(findSurvivors(project.record)).toEqual([]);
  });

  it("could not run when the build fails: shows why, never starts the specs, and stops the server it had started", async () => {
    const project = createFakeProject();

    const { exitCode, output } = await startCli(project, ["--mode", "fullstack"], { FAKE_BUILD_EXIT: "3" }).ended;

    expect(exitCode).toBe(2);
    expect(output).toContain('e2e could not run: the build of the client for mode "fullstack" failed (exit code 3)');
    expect(output).toContain("the bundler said: no such module");
    expect(Object.keys(readRecord(project.record)).map((name) => name.replace(/-\d+$/, ""))).toEqual(["server"]);
    expect(findSurvivors(project.record)).toEqual([]);
  });

  it("stops everything when it is interrupted, lets the test runner close its browser, and exits with the signal's code", async () => {
    const project = createFakeProject();
    const run = startCli(project, [], { FAKE_RUNNER: "hang" });

    await run.said("RUNNER STARTED");
    run.child.kill("SIGINT");

    const { exitCode, output } = await run.ended;

    expect(exitCode).toBe(130);
    expect(output).toContain("[e2e] interrupted (SIGINT): stopping");
    // The signal was passed on, not answered with a kill.
    expect(fileExists(project.record, "runner-heard-SIGINT")).toBe(true);
    expect(Object.keys(readRecord(project.record))).toHaveLength(4);
    expect(findSurvivors(project.record)).toEqual([]);
  });

  it("waits for nothing when it is asked a second time", async () => {
    const project = createFakeProject();
    const run = startCli(project, ["--mode", "sim"], { FAKE_RUNNER: "deaf" });

    await run.said("RUNNER STARTED");
    run.child.kill("SIGINT");
    await run.said("[e2e] interrupted (SIGINT): stopping");
    run.child.kill("SIGTERM");

    const { exitCode, output } = await run.ended;

    // The second signal ends it there and then: it is not passed on and waited out like the first.
    expect(exitCode).toBe(143);
    expect(output).not.toContain("interrupted (SIGTERM)");
    // Killed, not asked: gone a moment after the command is.
    await expect.poll(() => findSurvivors(project.record)).toEqual([]);
  });

  it("does the same when it is terminated", async () => {
    const project = createFakeProject();
    const run = startCli(project, [], { FAKE_RUNNER: "hang" });

    await run.said("RUNNER STARTED");
    run.child.kill("SIGTERM");

    expect((await run.ended).exitCode).toBe(143);
    expect(findSurvivors(project.record)).toEqual([]);
  });

  it("stops a stack that is still coming up when it is interrupted, and does not call that a fault", async () => {
    const project = createFakeProject();
    const run = startCli(project, [], { FAKE_RUNNER: "hang" });

    await run.said("[e2e] sim: client built and served");
    run.child.kill("SIGINT");

    const { exitCode, output } = await run.ended;

    expect(exitCode).toBe(130);
    expect(output).not.toContain("RUNNER STARTED");
    expect(output).not.toContain("could not run");
    expect(findSurvivors(project.record)).toEqual([]);
  });

  it("says how many specs ran to a tool that asked, from the runner's own results, and to no one otherwise", async () => {
    const project = createFakeProject();
    const asked = join(project.root, "asked/report.json");
    const results = JSON.stringify({ stats: { expected: 4, unexpected: 1, flaky: 0, skipped: 2 } });

    await startCli(project, ["--mode", "sim"], { FAKE_RESULTS: results, FAKE_RUNNER: "fail", MUTATION_CHECK_REPORT: asked }).ended;

    expect(JSON.parse(readFileSync(asked, "utf8"))).toEqual({ numPassedTests: 4, numFailedTests: 1 });

    rmSync(asked);

    const unasked = await startCli(project, ["--mode", "sim"], { FAKE_RESULTS: results, MUTATION_CHECK_REPORT: "" }).ended;

    expect(unasked.exitCode).toBe(0);
    expect(existsSync(asked)).toBe(false);
  });

  it("gives no count when the runner left no results, and never one an earlier run left", async () => {
    const project = createFakeProject();
    const asked = join(project.root, "asked/report.json");

    await startCli(project, ["--mode", "sim"], { FAKE_RESULTS: JSON.stringify({ stats: { expected: 4, unexpected: 0 } }) }).ended;
    await startCli(project, ["--mode", "sim"], { MUTATION_CHECK_REPORT: asked }).ended;

    expect(existsSync(asked)).toBe(false);
  });

  it("could not run without the project's config, and says what is missing", async () => {
    const project = createFakeProject();

    rmSync(join(project.root, "tools/e2e.config.mts"));

    const { exitCode, output } = await startCli(project).ended;

    expect(exitCode).toBe(2);
    expect(output).toContain("e2e could not run: tools/e2e.config.mts not found");
  });
});

describe("the command, without its signals", { timeout: REAL_PROCESS_TIMEOUT }, () => {
  it("could not run where no port can be opened: it starts nothing and does not report a pass", async () => {
    const project = createFakeProject();
    const groups = createGroups();
    const said: string[] = [];

    onTestFinished(groups.stopAll);

    const exitCode = await runCommand([], project.root, {
      groups,
      probe: () => Promise.resolve(false),
      complain: (line) => {
        said.push(line);
      },
    });

    expect(exitCode).toBe(2);
    expect(said.join("\n")).toContain("does not let a process listen on a port");
    expect(said.join("\n")).toContain("not verified here");
    expect(readRecord(project.record)).toEqual({});
  });

  it("prints how it is used for a mode with no name, and exits 2", async () => {
    const project = createFakeProject();
    const said: string[] = [];

    const exitCode = await runCommand(["--mode"], project.root, {
      groups: createGroups(),
      complain: (line) => {
        said.push(line);
      },
    });

    expect(exitCode).toBe(2);
    expect(said.join("\n")).toContain("usage: pnpm e2e");
  });

  it("could not run in a tests package that has nothing installed", async () => {
    const project = createFakeProject();
    const said: string[] = [];

    rmSync(join(project.root, "packages/e2e/node_modules"), { recursive: true });

    const exitCode = await runCommand([], project.root, {
      groups: createGroups(),
      complain: (line) => {
        said.push(line);
      },
    });

    expect(exitCode).toBe(2);
    expect(said).toEqual(["e2e could not run: packages/e2e has no node_modules — run pnpm install"]);
  });
});

describe("a program that misbehaves", { timeout: REAL_PROCESS_TIMEOUT }, () => {
  it("is given up on when it never says it is ready, with what it did say, and is stopped", async () => {
    const project = createFakeProject();
    const groups = createGroups();
    const start = startMode("sim", {
      root: project.root,
      config: project.config,
      groups,
      environment: { ...process.env, FAKE_RECORD: project.record, FAKE_SILENT: "client" },
      say: () => {},
      readyTimeoutMs: 1500,
    });

    await expect(start).rejects.toThrow(StartError);
    await expect(start).rejects.toThrow('the client of mode "sim" did not say it was ready within 1.5s');

    const [{ pids }] = Object.values(readRecord(project.record)) as [{ pids: number[] }];

    expect(isGroupAlive(pids[0] as number)).toBe(true);

    await groups.stopAll();

    expect(findSurvivors(project.record)).toEqual([]);
  });

  it("is not started at all once the run has been told to stop", async () => {
    const project = createFakeProject();
    const groups = createGroups();

    groups.signal("SIGINT");

    await expect(
      startMode("sim", { root: project.root, config: project.config, groups, environment: { ...process.env, FAKE_RECORD: project.record }, say: () => {} }),
    ).rejects.toThrow('the build of the client for mode "sim" was not started: the run is stopping');
    expect(readRecord(project.record)).toEqual({});
    expect(fileExists(project.root, "packages/e2e/node_modules/.cache/e2e/sim/built.json")).toBe(false);
  });

  it("is killed when it does not leave on the first signal, its child with it", async () => {
    const project = createFakeProject();
    const groups = createGroups(300);

    await startMode("sim", {
      root: project.root,
      config: project.config,
      groups,
      environment: { ...process.env, FAKE_RECORD: project.record, FAKE_STUBBORN: "client" },
      say: () => {},
    });

    expect(findSurvivors(project.record)).toHaveLength(2);

    await groups.stopAll();

    expect(findSurvivors(project.record)).toEqual([]);
  });

  it("is reported when it stops before it is ready", async () => {
    const project = createFakeProject();
    const groups = createGroups();
    const config = { ...project.config, client: { ...project.config.client, serve: [process.execPath, "-e", "console.error('port in use'); process.exit(4)", "{outDir}"] } };

    await expect(
      startMode("sim", {
        root: project.root,
        config,
        groups,
        environment: { ...process.env, FAKE_RECORD: project.record },
        say: () => {},
        readyTimeoutMs: 5000,
      }),
    ).rejects.toThrow(/the client of mode "sim" stopped before it was ready \(exit code 4\)\n--- its output ---\nport in use/);

    await groups.stopAll();
  });

  it("is reported when it cannot be started at all", async () => {
    const project = createFakeProject();
    const groups = createGroups();
    const config = { ...project.config, client: { ...project.config.client, serve: ["node_modules/.bin/no-such-program", "{outDir}"] } };

    await expect(
      startMode("sim", { root: project.root, config, groups, environment: { ...process.env, FAKE_RECORD: project.record }, say: () => {} }),
    ).rejects.toThrow('the client of mode "sim" could not be started');

    await groups.stopAll();
  });
});
