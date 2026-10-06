import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkServer, listConfigs } from "../files/tools/visual/check-server.mts";

const ADDON = join(import.meta.dirname, "..");
const SHIPPED = "packages/client-react/tests/visual/playwright.config.ts";
const CONFIG = "packages/web/tests/visual/playwright.config.ts";

/** A Playwright config whose server is started by `command`, written as source text. */
function createConfig(command: string): string {
  return `export default defineConfig({\n  webServer: {\n    cwd: PACKAGE,\n    command: ${command},\n    url: HOST_URL,\n  },\n});\n`;
}

function verdictOf(command: string): { exitCode: number; text: string } {
  const { exitCode, lines } = checkServer(createProject({ [CONFIG]: createConfig(command) }));

  return { exitCode, text: lines.join("\n") };
}

describe("the config the add-on ships", () => {
  it("starts vite by its own path, from the package's folder, and passes", () => {
    const shipped = readFileSync(join(ADDON, "files", SHIPPED), "utf8");
    const verdict = checkServer(createProject({ [SHIPPED]: shipped }));

    expect(shipped).toContain('command: "node_modules/.bin/vite --config tests/visual/host/vite.config.ts"');
    expect(shipped).toContain("cwd: PACKAGE,");
    expect(verdict).toEqual({ exitCode: 0, lines: ["PASS web-server: 1 server command(s) in 1 Playwright config(s), none through pnpm."] });
  });
});

describe("a server started through pnpm", () => {
  it.each([
    '"pnpm exec vite --config tests/visual/host/vite.config.ts"',
    '"pnpm run dev"',
    '"pnpm --filter @app/client-react dev"',
    '"pnpm dev"',
    "'pnpm exec vite'",
    "`pnpm exec vite --port ${PORT}`",
    '"corepack pnpm exec vite"',
    '"node_modules/.bin/pnpm exec vite"',
    '"NODE_ENV=test pnpm exec vite"',
    '"cd ../.. && pnpm exec vite"',
    '\n      "pnpm exec vite --config tests/visual/host/vite.config.ts"',
  ])("fails: command: %s", (command) => {
    const { exitCode, text } = verdictOf(command);

    expect(text).toContain("FAIL web-server");
    expect(text).toContain("the server is started through pnpm (`");
    expect(exitCode).toBe(1);
  });

  it("names the file and the line of the command, and says what to write instead", () => {
    const { text } = verdictOf('"pnpm exec vite"');

    expect(text).toContain(`${CONFIG}:4: the server is started through pnpm (\`pnpm exec vite\`).`);
    expect(text).toContain("the run never ends after its tests pass");
    expect(text).toContain('`command: "node_modules/.bin/vite …"`');
  });

  it("judges every server of a config that starts several", () => {
    const config = 'export default { webServer: [{ command: "node_modules/.bin/vite" }, { command: "pnpm exec tsx server.ts" }] };\n';
    const verdict = checkServer(createProject({ [CONFIG]: config }));

    expect(verdict.exitCode).toBe(1);
    expect(verdict.lines).toHaveLength(2);
    expect(verdict.lines[1]).toContain("pnpm exec tsx server.ts");
  });
});

describe("a server started by its own path", () => {
  it.each([
    '"node_modules/.bin/vite --config tests/visual/host/vite.config.ts"',
    '"node server.mts"',
    '"node_modules/.bin/vite --mode pnpm"',
    '"pnpm-serve --port 4319"',
    '"node tools/serve.mts --with pnpm exec"',
  ])("passes: command: %s", (command) => {
    expect(verdictOf(command)).toEqual({ exitCode: 0, text: "PASS web-server: 1 server command(s) in 1 Playwright config(s), none through pnpm." });
  });
});

describe("nothing to judge", () => {
  it("says SKIP, not PASS, when no config starts a server", () => {
    const verdict = checkServer(createProject({ [CONFIG]: 'export default { use: { baseURL: "http://localhost:1" } };\n' }));

    expect(verdict).toEqual({ exitCode: 0, lines: ["SKIP web-server: no Playwright config in the project starts a server, so there was nothing to check."] });
  });

  it("says SKIP when the project has no Playwright config at all", () => {
    expect(checkServer(createProject({ "package.json": "{}" })).lines[0]).toMatch(/^SKIP web-server/);
  });

  it("could not run when a server's command is not a string it can read", () => {
    const verdict = checkServer(createProject({ [CONFIG]: createConfig("SERVER_COMMAND") }));

    expect(verdict.exitCode).toBe(2);
    expect(verdict.lines).toEqual(["web-server could not run:", `  ${CONFIG}:4: the command is not a string written here, so it cannot be read. Write it as a string beside \`command:\`.`]);
  });

  it("could not run when a config has a webServer and no command at all", () => {
    const verdict = checkServer(createProject({ [CONFIG]: "export default { webServer: createServer() };\n" }));

    expect(verdict.exitCode).toBe(2);
    expect(verdict.lines[1]).toContain("it has a webServer and no `command:` this check can find");
  });
});

describe("which files are Playwright configs", () => {
  it("finds them by name anywhere in the project, and leaves installed and generated folders alone", () => {
    const root = createProject({
      "playwright.config.ts": "",
      "packages/web/playwright.e2e.config.mts": "",
      "packages/web/tests/visual/playwright.config.ts": "",
      "packages/web/vite.config.ts": "",
      "packages/web/playwright.config.json": "",
      "node_modules/pkg/playwright.config.ts": "",
      "packages/web/dist/playwright.config.ts": "",
      "tools/visual/playwright.config.ts": "",
    });

    expect(listConfigs(root)).toEqual(["packages/web/playwright.e2e.config.mts", "packages/web/tests/visual/playwright.config.ts", "playwright.config.ts"]);
  });
});

describe("the script", () => {
  it("judges the project it is installed in, and exits with the verdict", () => {
    const bad = createProject({ [CONFIG]: createConfig('"pnpm exec vite"') });
    const good = createProject({ [CONFIG]: createConfig('"node_modules/.bin/vite"') });

    for (const root of [bad, good]) {
      cpSync(join(ADDON, "files/tools"), join(root, "tools"), { recursive: true });
    }

    const run = (root: string) => spawnSync(process.execPath, ["tools/visual/check-server.mts"], { cwd: root, encoding: "utf8" });

    expect(run(bad).status).toBe(1);
    expect(run(bad).stdout).toContain("FAIL web-server");
    expect(run(good).status).toBe(0);
  });
});

describe("the add-on's manifest", () => {
  const manifest = JSON.parse(readFileSync(join(ADDON, "addon.json"), "utf8")) as {
    packageJson: Record<string, { scripts?: Record<string, string> }>;
    gates: { fast: string[] };
  };

  it("runs the check in gate:fast, as a script of its own", () => {
    expect(manifest.packageJson["."]?.scripts?.["visual:check:server"]).toBe("node tools/visual/check-server.mts");
    expect(manifest.gates.fast).toEqual(["pnpm visual:check", "pnpm visual:check:server"]);
  });
});

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "visual-server-"));

  scratch.push(root);

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }

  return root;
}
