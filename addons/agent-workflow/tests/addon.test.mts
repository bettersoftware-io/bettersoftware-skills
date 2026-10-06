import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { addToProject } from "../../../scripts/add-to-project.mts";
import { changelog } from "../files/tools/agent-workflow/changelog.mts";
import { APPROVING_HOST, ASK_RULES, CLAUDE_SETTINGS, CODEX_HOOKS, COMMAND_NEEDS, CONFIG_FILE, HOOK_SCRIPT } from "../files/tools/agent-workflow/lib/host.mts";
import { ADDON, createFolder, readJson, REPOSITORY, writeFile } from "./support.mts";

interface HookGroup {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

interface HostSettings {
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

interface Manifest {
  recommended: boolean;
  packageJson: Record<string, { scripts?: Record<string, string>; devDependencies?: Record<string, string> }>;
  gates: { fast: string[]; full: string[] };
  startingFiles: string[];
  hostSettings: Record<string, HostSettings>;
  verify: string;
}

const MANIFEST = readJson<Manifest>(ADDON, "addon.json");
const FILES = readdirSync(join(ADDON, "files"), { recursive: true, encoding: "utf8" });
const WORKFLOW = readFileSync(join(ADDON, "files/.github/workflows/weekly-tag.yml"), "utf8");
const COMMANDS = Object.keys(COMMAND_NEEDS);
const SECTION = readFileSync(join(ADDON, "AGENTS.section.md"), "utf8");

describe("the add-on's manifest", () => {
  it("is offered, not recommended", () => {
    expect(MANIFEST.recommended).toBe(false);
  });

  it("adds scripts that each run a tool it ships, and proves itself with one of them", () => {
    const scripts = MANIFEST.packageJson["."]?.scripts ?? {};

    expect(Object.keys(scripts)).toEqual(["worktree", "changelog", "agent-workflow:check"]);

    for (const script of Object.values(scripts)) {
      const tool = /^node (tools\/agent-workflow\/[\w-]+\.mts)$/.exec(script)?.[1];

      expect(tool !== undefined && existsSync(join(ADDON, "files", tool)), script).toBe(true);
    }

    expect(MANIFEST.verify).toBe("pnpm agent-workflow:check");
  });

  it("installs no package and joins no gate: a host's settings are the project's to change", () => {
    expect(Object.values(MANIFEST.packageJson).filter((patch) => patch.devDependencies !== undefined)).toEqual([]);
    expect(MANIFEST.gates).toEqual({ fast: [], full: [] });
  });

  it("leaves CHANGELOG.md and the setting file to the project once they are written", () => {
    expect(MANIFEST.startingFiles).toEqual(["CHANGELOG.md", CONFIG_FILE]);
    expect(existsSync(join(ADDON, "files", CONFIG_FILE))).toBe(true);
  });

  it("ships TypeScript and nothing else that runs", () => {
    expect(FILES.filter((file) => /\.(js|mjs|cjs|jsx|py|sh|bash)$/.test(file))).toEqual([]);
    expect(FILES.filter((file) => file.endsWith(".mts")).length).toBeGreaterThan(5);
  });

  it("asks each host for the same entries the project's own check looks for", () => {
    const claude = MANIFEST.hostSettings[CLAUDE_SETTINGS];
    const codex = MANIFEST.hostSettings[CODEX_HOOKS];

    expect(Object.keys(MANIFEST.hostSettings)).toEqual([CLAUDE_SETTINGS, CODEX_HOOKS]);
    expect(claude?.permissions).toEqual({ ask: ASK_RULES });
    expect(claude?.hooks).toEqual({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node "$CLAUDE_PROJECT_DIR/${HOOK_SCRIPT}" ${APPROVING_HOST}`, timeout: 5 }] }],
    });
    expect(Object.keys(codex ?? {})).toEqual(["hooks"]);
    expect(codex?.hooks?.PreToolUse).toHaveLength(1);
    expect(codex?.hooks?.PreToolUse?.[0]?.matcher).toBe("Bash");
    expect(codex?.hooks?.PreToolUse?.[0]?.hooks[0]?.command).toBe(`node ${HOOK_SCRIPT}`);
    expect(existsSync(join(ADDON, "files", HOOK_SCRIPT))).toBe(true);
  });
});

// A model of how a rule is matched, as the host documents it: `*` stands for
// any text, everything else is literal, and the whole command must match. It
// is not the host's own code, so what it proves is that the rules say what
// they are meant to say, not that a given version of the host reads them so.
describe("the permission rules, read the way the host documents them", () => {
  it("are ask rules only: what runs without a prompt is the hook's to decide, by exact shape", () => {
    expect(MANIFEST.hostSettings[CLAUDE_SETTINGS]?.permissions).toEqual({ ask: ASK_RULES });
    expect(JSON.stringify(MANIFEST.hostSettings)).not.toContain('"allow"');
    expect(JSON.stringify(MANIFEST.hostSettings)).not.toContain('"deny"');
  });

  it.each([
    "git push --force origin worktree-a",
    "git push -u origin worktree-a --force",
    "git push origin worktree-a --force-with-lease",
    "git push --force-with-lease=worktree-a origin worktree-a",
    "git push --force-if-includes origin worktree-a",
    "git push -f origin worktree-a",
    "git push origin worktree-a -f",
    "git push -u origin worktree-a -fu",
    "git push origin +worktree-a",
    "git push -u origin +worktree-a",
    "git push origin worktree-a:main",
    "git push origin worktree-a +main",
    "git push origin worktree-a --delete main",
    "git push origin --delete worktree-a",
    "git push -d origin worktree-a",
    "git push origin -d worktree-a",
    "git push --mirror origin",
    "git push origin --mirror",
    "git push --all origin",
    "git push origin --all",
    "git push origin worktree-a --tags",
    "git push --tags",
    "git push --prune origin worktree-a",
    "gh pr merge 12 --admin",
    "gh pr merge 12 --merge --admin --delete-branch",
  ])("always asks: %s", (command) => {
    expect(asks(command)).toBe(true);
  });

  it.each([
    "git push",
    "git push origin main",
    "git push -u origin worktree-rates-filter",
    "git push origin worktree-f-key-fix",
    "git push -u origin worktree-force-refresh",
    "git push origin worktree-delete-button",
    "git push origin worktree-all-tags",
    "gh pr merge 12 --merge --delete-branch",
    "gh pr create --title t --body b",
    "git pushd --force",
  ])("says nothing about: %s", (command) => {
    expect(asks(command)).toBe(false);
  });
});

describe("the weekly-tag workflow", () => {
  it("pins every action by a full commit hash, with its version beside it", () => {
    const uses = [...WORKFLOW.matchAll(/^\s*-?\s*uses: (.+)$/gm)].map((match) => match[1] ?? "");

    expect(uses.length).toBeGreaterThan(0);

    for (const action of uses) {
      expect(action).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+/);
    }
  });

  it("uses the same pins as the starter's own workflow", () => {
    const starter = readFileSync(join(REPOSITORY, "starter/.github/workflows/ci.yml"), "utf8");

    for (const [, action] of WORKFLOW.matchAll(/uses: (\S+)/g)) {
      expect(starter).toContain(`uses: ${action}`);
    }
  });

  it("can only read by default, and gives the one job that writes exactly what it needs", () => {
    const [top, job] = WORKFLOW.split(/^jobs:$/m);

    expect(top).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect([...(job ?? "").matchAll(/^ {6}([\w-]+): (read|write) # \S.+$/gm)].map((match) => `${match[1]}: ${match[2]}`)).toEqual([
      "contents: write",
      "issues: write",
      "pull-requests: read",
    ]);
  });

  it("never runs twice at once, and never cancels a run that may be half way through tagging", () => {
    expect(WORKFLOW).toMatch(/^concurrency:\n {2}group: weekly-tag\n {2}cancel-in-progress: false\n/m);
  });

  it("does not leave the token in the checkout, and takes the history it needs", () => {
    expect(WORKFLOW).toMatch(/persist-credentials: false/);
    expect(WORKFLOW).toMatch(/fetch-depth: 0/);
  });

  it("puts no expression in a command line, and does not run on another repository's code", () => {
    const runs = [...WORKFLOW.matchAll(/^\s*run: (.+)$/gm)].map((match) => match[1] ?? "");

    expect(runs).toEqual(["node tools/agent-workflow/close-week.mts"]);
    expect(WORKFLOW).not.toMatch(/pull_request_target|workflow_run/);
    expect(WORKFLOW).toMatch(/^on:\n {2}schedule:\n {4}- cron: "5 0 \* \* 1"\n {2}workflow_dispatch:\n/m);
  });

  it("installs nothing before the step that holds the token that can write", () => {
    expect(WORKFLOW).not.toMatch(/pnpm install|npm install|corepack/);
    expect(WORKFLOW).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
  });
});

describe("the commands", () => {
  it("are the three the check knows about", () => {
    expect(readdirSync(join(ADDON, "files/.claude/commands/workflow")).sort()).toEqual(COMMANDS.map((name) => `${name}.md`).sort());
  });

  it.each(COMMANDS)("%s says what it does, and what it may run", (name) => {
    const { frontmatter } = readCommand(name);

    expect(frontmatter).toMatch(/^description: \S.{20,}$/m);
    expect(frontmatter).toMatch(/^allowed-tools: /m);
  });

  // A block run before the command is read is parsed by the host and matched
  // against `allowed-tools`. One it will not analyse yields an error in place
  // of data, and the command carries on. These commands have none.
  it.each(COMMANDS)("%s runs nothing before it is read", (name) => {
    expect(readCommand(name).text).not.toMatch(/!`/);
  });

  it.each(COMMANDS)("%s tells a host that does not fill in the arguments where to take them from", (name) => {
    const { body } = readCommand(name);

    expect(body).toContain("`$ARGUMENTS`");
    expect(body).toMatch(/this\s+host does not fill it in/);
  });

  it.each(Object.entries(COMMAND_NEEDS).filter(([, needs]) => needs !== undefined))(
    "%s first asks whether the %s add-on is there, and stops if it is not",
    (name, needs) => {
      const { body } = readCommand(name);
      const first = /^## (\d+)\. (.+)$/m.exec(body);

      expect(first?.[1]).toBe("0");
      expect(first?.[2]).toBe(`This needs the ${needs} add-on`);
      expect(body.slice(first?.index, body.indexOf("\n## ", (first?.index ?? 0) + 1))).toContain(`node tools/agent-workflow/requires.mts ${needs}`);
      expect(body).toMatch(/If it does not exit 0, report the line it printed and stop/);
      expect(existsSync(join(REPOSITORY, "addons", needs as string, "addon.json"))).toBe(true);
    },
  );

  it("needs no other add-on for the changelog", () => {
    expect(COMMAND_NEEDS.changelog).toBeUndefined();
    expect(readCommand("changelog").text).not.toContain("requires.mts");
  });

  it.each(COMMANDS)("%s names only scripts that this add-on, the one it needs, or the starter has", (name) => {
    const known = new Set([...scriptsOf(join(ADDON, "addon.json")), ...Object.keys(readJson<{ scripts: Record<string, string> }>(REPOSITORY, "starter/package.json").scripts)]);
    const needs = COMMAND_NEEDS[name];

    for (const script of needs === undefined ? [] : scriptsOf(join(REPOSITORY, "addons", needs, "addon.json"))) {
      known.add(script);
    }

    const named = [...readCommand(name).body.matchAll(/pnpm ([a-z][\w:-]*)/g)].map((match) => match[1] ?? "");

    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((script) => !known.has(script))).toEqual([]);
  });

  it.each(COMMANDS)("%s has a skill of the same name for Codex, which points at it", (name) => {
    const skill = readFileSync(join(ADDON, "files/.agents/skills", `workflow-${name}`, "SKILL.md"), "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";

    expect(frontmatter).toMatch(new RegExp(`^name: workflow-${name}$`, "m"));
    expect(frontmatter).toMatch(/^description: Use when .{20,}$/m);
    expect(skill).toContain(`\`.claude/commands/workflow/${name}.md\``);
    expect(skill).toMatch(/`\$ARGUMENTS` is not filled in/);
  });

  it("has no skill for Codex without a command behind it", () => {
    expect(readdirSync(join(ADDON, "files/.agents/skills")).sort()).toEqual(COMMANDS.map((name) => `workflow-${name}`).sort());
  });
});

describe("the section for AGENTS.md", () => {
  it("names only scripts the add-on adds or the starter has", () => {
    const known = new Set([...scriptsOf(join(ADDON, "addon.json")), ...Object.keys(readJson<{ scripts: Record<string, string> }>(REPOSITORY, "starter/package.json").scripts)]);
    const named = [...SECTION.matchAll(/pnpm ([a-z][\w:-]*)/g)].map((match) => match[1] ?? "");

    expect(named).toContain("worktree");
    expect(named.filter((script) => !known.has(script))).toEqual([]);
  });

  it("points at command files that are shipped", () => {
    const paths = [...SECTION.matchAll(/`(\.claude\/commands\/workflow\/[\w-]+\.md)`/g)].map((match) => match[1] ?? "");

    expect(paths).toHaveLength(3);

    for (const path of paths) {
      expect(existsSync(join(ADDON, "files", path)), path).toBe(true);
    }
  });

  it("says where approval is turned off, and names no pattern rule as what approves", () => {
    expect(SECTION).toContain(`\`${CONFIG_FILE}\``);
    expect(SECTION).toContain("approveExactShapes");
    expect(SECTION).not.toMatch(/worktree-\*|pr merge \*|pr create \*/);
  });
});

describe("the changelog it starts a project with", () => {
  it("has no week yet, and passes its own check for a week in which nothing was merged", () => {
    const root = createFolder({ "CHANGELOG.md": readFileSync(join(ADDON, "files/CHANGELOG.md"), "utf8") });
    const lines: string[] = [];
    const status = changelog({
      root,
      argv: ["check", "2026-W40", "--merged", ""],
      now: new Date("2026-10-06T00:00:00Z"),
      run: () => ({ status: 127, stdout: "", stderr: "" }),
      report: (line) => lines.push(line),
    });

    expect(lines).toEqual(["PASS changelog 2026-W40: 0 merged pull request(s), all cited, every citation defined"]);
    expect(status).toBe(0);
  });
});

describe("the add-on in a project that has the kit", () => {
  it("merges its hook and its rules into both hosts' settings, beside the kit's hooks", () => {
    const project = createProjectWithKit();
    const kitClaude = readJson<HostSettings>(project, CLAUDE_SETTINGS);
    const kitCodex = readJson<HostSettings>(project, CODEX_HOOKS);

    const result = addToProject({ project, unit: "agent-workflow", repository: REPOSITORY, scope: "@acme" });
    const claude = readJson<HostSettings>(project, CLAUDE_SETTINGS);
    const codex = readJson<HostSettings>(project, CODEX_HOOKS);

    expect(claude.hooks?.PostToolUse).toEqual(kitClaude.hooks?.PostToolUse);
    expect(claude.hooks?.Stop).toEqual(kitClaude.hooks?.Stop);
    expect(claude.hooks?.PreToolUse).toEqual(MANIFEST.hostSettings[CLAUDE_SETTINGS]?.hooks?.PreToolUse);
    expect(claude.permissions).toEqual({ ask: ASK_RULES });
    expect(codex.description).toBe(kitCodex.description);
    expect(codex.hooks?.Stop).toEqual(kitCodex.hooks?.Stop);
    expect(codex.hooks?.PreToolUse).toEqual(MANIFEST.hostSettings[CODEX_HOOKS]?.hooks?.PreToolUse);
    expect(result.settingsChanges).toHaveLength(ASK_RULES.length + 2);
    expect(result.notes).toEqual([]);
  });

  it("leaves both settings files byte for byte as they were when it is added a second time", () => {
    const project = createProjectWithKit();

    addToProject({ project, unit: "agent-workflow", repository: REPOSITORY, scope: "@acme" });

    const before = [CLAUDE_SETTINGS, CODEX_HOOKS].map((path) => readFileSync(join(project, path), "utf8"));
    const again = addToProject({ project, unit: "agent-workflow", repository: REPOSITORY, scope: "@acme" });

    expect([CLAUDE_SETTINGS, CODEX_HOOKS].map((path) => readFileSync(join(project, path), "utf8"))).toEqual(before);
    expect(again.settingsChanges).toEqual([]);
    expect(again.files.written).toEqual([]);
  });

  it("never drops a rule, a hook or a setting the project added, before or after", () => {
    const project = createProjectWithKit();
    const own = readJson<HostSettings>(project, CLAUDE_SETTINGS);

    own.model = "opus";
    own.permissions = { allow: ["Bash(make *)"], deny: ["Bash(rm -rf *)"], ask: ["Bash(npm publish *)"] };
    own.hooks = { ...own.hooks, PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "node tools/own/guard.mts" }] }] };
    writeFile(project, CLAUDE_SETTINGS, JSON.stringify(own));

    addToProject({ project, unit: "agent-workflow", repository: REPOSITORY, scope: "@acme" });

    const merged = readJson<HostSettings>(project, CLAUDE_SETTINGS);

    merged.permissions?.allow?.push("Bash(pnpm test)");
    writeFile(project, CLAUDE_SETTINGS, JSON.stringify(merged));
    addToProject({ project, unit: "agent-workflow", repository: REPOSITORY, scope: "@acme" });

    const final = readJson<HostSettings>(project, CLAUDE_SETTINGS);

    expect(final.model).toBe("opus");
    expect(final.permissions).toEqual({
      allow: ["Bash(make *)", "Bash(pnpm test)"],
      deny: ["Bash(rm -rf *)"],
      ask: ["Bash(npm publish *)", ...ASK_RULES],
    });
    expect(final.hooks?.PreToolUse?.map((group) => group.hooks[0]?.command)).toEqual([
      "node tools/own/guard.mts",
      `node "$CLAUDE_PROJECT_DIR/${HOOK_SCRIPT}" ${APPROVING_HOST}`,
    ]);
    expect(final.hooks?.Stop).toEqual(own.hooks.Stop);
  });

  it("adds a rule again that the project took out: it cannot tell a rule removed from one never added", () => {
    const project = createProjectWithKit();

    addToProject({ project, unit: "agent-workflow", repository: REPOSITORY, scope: "@acme" });

    const settings = readJson<HostSettings>(project, CLAUDE_SETTINGS);

    settings.permissions = { ...settings.permissions, ask: ASK_RULES.filter((rule) => !rule.includes("--tags")) };
    writeFile(project, CLAUDE_SETTINGS, JSON.stringify(settings));

    const again = addToProject({ project, unit: "agent-workflow", repository: REPOSITORY, scope: "@acme" });

    expect(again.settingsChanges).toEqual([`${CLAUDE_SETTINGS}: permissions.ask: Bash(git push *--tags*)`]);
  });

  it("proves itself in the project it was just added to, with the command the manifest names", () => {
    const project = createProjectWithKit();

    addToProject({ project, unit: "agent-workflow", repository: REPOSITORY, scope: "@acme" });

    const script = readJson<{ scripts: Record<string, string> }>(project, "package.json").scripts["agent-workflow:check"] ?? "";
    const verify = spawnSync(process.execPath, script.replace(/^node /, "").split(" "), { cwd: project, encoding: "utf8" });

    expect(MANIFEST.verify).toBe("pnpm agent-workflow:check");
    expect(verify.stdout).toContain("PASS hook: refuses an outward step joined to others, says nothing about a push to main, and never approves without --host=claude-code");
    expect(verify.stdout).toContain("PASS approval: on.");
    expect(verify.stdout).toContain("PASS Claude Code: all 13 ask rules are in");
    expect(verify.stdout).toContain("PASS Codex: .codex/hooks.json runs the hook before each shell command");
    expect(verify.stdout).not.toContain("FAIL");
    expect(verify.status).toBe(0);
  });

  it("fails that proof once the hook is taken out of a host's settings", () => {
    const project = createProjectWithKit();

    addToProject({ project, unit: "agent-workflow", repository: REPOSITORY, scope: "@acme" });

    const codex = readJson<HostSettings>(project, CODEX_HOOKS);

    delete codex.hooks?.PreToolUse;
    writeFileSync(join(project, CODEX_HOOKS), JSON.stringify(codex));

    const verify = spawnSync(process.execPath, ["tools/agent-workflow/check.mts"], { cwd: project, encoding: "utf8" });

    expect(verify.status).toBe(1);
    expect(verify.stdout).toContain("FAIL Codex: .codex/hooks.json does not register");
  });

  it("keeps approval off once the project turns it off, and its proof then says so without failing", () => {
    const project = createProjectWithKit();

    addToProject({ project, unit: "agent-workflow", repository: REPOSITORY, scope: "@acme" });
    writeFile(project, CONFIG_FILE, "export const approveExactShapes: boolean = false;\n");
    addToProject({ project, unit: "agent-workflow", repository: REPOSITORY, scope: "@acme" });

    const verify = spawnSync(process.execPath, ["tools/agent-workflow/check.mts"], { cwd: project, encoding: "utf8" });

    expect(readFileSync(join(project, CONFIG_FILE), "utf8")).toBe("export const approveExactShapes: boolean = false;\n");
    expect(verify.stdout).toContain("NOTE approval: off. tools/agent-workflow.config.mts does not set approveExactShapes to true");
    expect(verify.stdout).toContain("PASS hook: refuses an outward step joined to others");
    expect(verify.stdout).not.toContain("FAIL");
    expect(verify.status).toBe(0);
  });

  it("writes the changelog once, the commands, the skills for Codex and the workflow", () => {
    const project = createProjectWithKit();
    const result = addToProject({ project, unit: "agent-workflow", repository: REPOSITORY, scope: "@acme" });

    expect(result.created).toEqual(["CHANGELOG.md", CONFIG_FILE]);
    expect(result.files.written).toEqual(expect.arrayContaining([".github/workflows/weekly-tag.yml", ".claude/commands/workflow/changelog.md", ".agents/skills/workflow-changelog/SKILL.md", HOOK_SCRIPT]));

    writeFile(project, "CHANGELOG.md", "# Changelog\n\n## 2026-W40 — the project's own entry\n");
    addToProject({ project, unit: "agent-workflow", repository: REPOSITORY, scope: "@acme" });

    expect(readFileSync(join(project, "CHANGELOG.md"), "utf8")).toContain("the project's own entry");
  });
});

/** Whether an ask rule matches the command. */
function asks(command: string): boolean {
  return ASK_RULES.some((rule) => {
    const pattern = /^Bash\((.*)\)$/.exec(rule)?.[1] ?? "";

    return new RegExp(`^${pattern.split("*").map(escapeForRegExp).join(".*")}$`).test(command);
  });
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readCommand(name: string): { text: string; frontmatter: string; body: string } {
  const text = readFileSync(join(ADDON, "files/.claude/commands/workflow", `${name}.md`), "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";

  return { text, frontmatter, body: text.slice(frontmatter.length + 8) };
}

function scriptsOf(manifest: string): string[] {
  const { packageJson } = JSON.parse(readFileSync(manifest, "utf8")) as Manifest;

  return Object.values(packageJson).flatMap((patch) => Object.keys(patch.scripts ?? {}));
}

/** A small project with the real kit in it, as `create-project.mts` leaves one. */
function createProjectWithKit(): string {
  const project = createFolder({
    "package.json": `${JSON.stringify({ name: "project", scripts: { "gate:fast": "pnpm gates", "gate:full": "pnpm gate:fast" } }, null, 2)}\n`,
    "packages/web/package.json": '{ "name": "@acme/web" }\n',
    "AGENTS.md": "# Working here\n",
  });

  addToProject({ project, unit: "kit", repository: REPOSITORY });

  return project;
}
