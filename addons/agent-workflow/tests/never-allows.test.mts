import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";

import { type Answer, type CommandPayload, judgeCall, replyTo } from "../files/tools/agent-workflow/hooks/split-outward-commands.mts";
import { HOOK_SCRIPT, RETIRED_ARGUMENT } from "../files/tools/agent-workflow/lib/host.mts";
import { judgeCommand, mentionsOutward } from "../files/tools/agent-workflow/lib/outward.mts";
import { DEEPEST_NESTING, LimitError, LONGEST_SCRIPT, parseShell } from "../files/tools/agent-workflow/lib/shell.mts";
import { NEAR_MISSES, OLD_SETTING_ON, ONCE_ALLOWED } from "./shapes.mts";
import { ADDON, createProject, readJson, runHook } from "./support.mts";

interface Manifest {
  hostSettings: Record<string, { hooks: { PreToolUse: { hooks: { command: string }[] }[] } }>;
  retiredHookCommands: Record<string, string>;
}

const MANIFEST = readJson<Manifest>(ADDON, "addon.json");
/** For a test that starts the hook once per command of a table. */
const SPAWNS_TIMEOUT = 120_000;
/** A push, a pull request opened and a merge, from the table. */
const ONE_OF_EACH = [/^git push /, /^gh pr create /, /^gh pr merge /].map((kind) => ONCE_ALLOWED.find((command) => kind.test(command)) ?? "");

// An earlier version of the hook answered `allow` for thirty commands when a
// project had turned that on. It was removed. These tests keep it removed:
// whatever the hook is sent, and however it is started, it prints nothing or
// a refusal.
describe("what the hook can say", () => {
  it("is a refusal and nothing else, by its type", () => {
    expectTypeOf<Answer["decision"]>().toEqualTypeOf<"deny">();
    expectTypeOf(judgeCall).returns.toEqualTypeOf<Answer | undefined>();
    expectTypeOf(judgeCall).parameters.toEqualTypeOf<[CommandPayload]>();
    expectTypeOf(replyTo).parameters.toEqualTypeOf<[string]>();
  });

  it("is told apart from nothing by the same test that reads every answer below", () => {
    expect(decisionIn("")).toBe("none");
    expect(decisionIn(replyTo(JSON.stringify(createCall("git commit -m wip && git push"))))).toBe("deny");
    expect(decisionIn('{"hookSpecificOutput":{"permissionDecision":"allow"}}')).toBe("allow");
    expect(decisionIn('{"hookSpecificOutput":{"permissionDecision":"ask"}}')).toBe("ask");
    expect(decisionIn("allow")).toBe("not an answer");
  });
});

// The project is one in which that version did answer `allow`: a real
// repository with a real `origin`, the work branch there, the session in the
// mode that asks, and the old setting file with everything turned on.
describe("a command the hook once let run without a prompt, piped to the hook as a program", () => {
  const before = createProject(OLD_SETTING_ON);
  const starts: [string, string[]][] = [
    ["Claude Code starts it", argumentsOf(MANIFEST.hostSettings[".claude/settings.json"]?.hooks.PreToolUse[0]?.hooks[0]?.command)],
    ["Codex starts it", argumentsOf(MANIFEST.hostSettings[".codex/hooks.json"]?.hooks.PreToolUse[0]?.hooks[0]?.command)],
    ["an older registration starts it", argumentsOf(Object.keys(MANIFEST.retiredHookCommands)[0])],
    ["nobody should: with words it never knew", ["--host=codex", "--allow", "allow"]],
  ];

  it("is one of thirty", () => {
    expect(ONCE_ALLOWED).toHaveLength(30);
    expect(new Set(ONCE_ALLOWED).size).toBe(30);
  });

  it("is started with no argument now, and was started with one before", () => {
    expect(starts.map(([, args]) => args).slice(0, 3)).toEqual([[], [], [RETIRED_ARGUMENT]]);
  });

  it.each(starts)("gets no answer, as %s", (_name, args) => {
    const answered = ONCE_ALLOWED.map((command) => runHook(before, command, { args })).filter(({ status, stdout, stderr }) => status !== 0 || stdout !== "" || stderr !== "");

    expect(answered).toEqual([]);
  }, SPAWNS_TIMEOUT);

  it.each(starts)("is refused once another command is joined to it, as %s", (_name, args) => {
    const decisions = ONE_OF_EACH.map((command) => runHook(before, `git commit -m wip && ${command}`, { args }).decision);

    expect(decisions).toEqual(["deny", "deny", "deny"]);
  }, SPAWNS_TIMEOUT);

  it.each(["acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"])("gets no answer in the permission mode %s", (mode) => {
    expect(runHook(before, "git push -u origin worktree-a", { change: { permission_mode: mode }, args: [RETIRED_ARGUMENT] })).toMatchObject({ status: 0, stdout: "" });
  });

  it("starts no program: it answers the same with nothing on its PATH and no home", () => {
    const bare = { env: { PATH: "", HOME: "/nowhere" } };

    expect(runHook(before, "git push -u origin worktree-a", bare)).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(runHook(before, "git add -A && git push -u origin worktree-a", bare).decision).toBe("deny");
  });
});

// Each table entry alone, joined to another by each separator in both
// orders, and wrapped the ways a shell wraps one.
describe("the hook, over thousands of commands put together from the tables", () => {
  const pieces = [...ONCE_ALLOWED, ...NEAR_MISSES.map(([, command]) => command)];
  const joins = [" && ", "; ", " || ", " & ", "\n", " | ", " |& ", ";", "&&"];
  const wraps: ((command: string) => string)[] = [
    (command) => `(${command})`,
    (command) => `{ ${command}; }`,
    (command) => `echo "$(${command})"`,
    (command) => `echo \`${command}\``,
    (command) => `bash -c '${command.replaceAll("'", "'\\''")}'`,
    (command) => `cd /elsewhere && ${command}`,
    (command) => `${command} > out.log`,
    (command) => `X=1 ${command}`,
    (command) => ` ${command}`,
    (command) => `${command}\n`,
  ];
  const generated = [
    ...ONCE_ALLOWED.flatMap((once) => pieces.flatMap((piece, index) => (index % 3 === 0 ? joins.flatMap((join) => [`${once}${join}${piece}`, `${piece}${join}${once}`]) : []))),
    ...pieces.flatMap((piece) => wraps.map((wrap) => wrap(piece))),
    ...pieces,
  ];
  const shapes: ((command: string) => unknown)[] = [
    (command) => createCall(command),
    (command) => ({ ...createCall(command), cwd: "/project", permission_mode: "default" }),
    (command) => ({ tool_name: "Shell", tool_input: { command: ["bash", "-lc", command] } }),
  ];

  it("is asked about more than five thousand, no near-miss given twice", () => {
    expect(generated.length).toBeGreaterThan(5000);
    expect(new Set(NEAR_MISSES.map(([, command]) => command)).size).toBe(NEAR_MISSES.length);
    expect(NEAR_MISSES.length).toBeGreaterThan(150);
  });

  it.each(shapes.map((shape, index) => [index, shape] as const))("prints nothing or a refusal for every one, in payload shape %i", (_index, shape) => {
    const decisions = new Map<string, number>();

    for (const command of generated) {
      const decision = decisionIn(replyTo(JSON.stringify(shape(command))));

      decisions.set(decision, (decisions.get(decision) ?? 0) + 1);
    }

    expect([...decisions.keys()].sort()).toEqual(["deny", "none"]);
    expect(decisions.get("deny")).toBeGreaterThan(1000);
    expect(decisions.get("none")).toBeGreaterThan(200);
  });

  it("says nothing about each of the thirty alone, and the same with a space in front", () => {
    expect(ONCE_ALLOWED.flatMap((command) => [command, ` ${command}`]).filter((command) => judgeCall(createCall(command)) !== undefined)).toEqual([]);
  });

  it("refuses every one that joins one of the thirty to another command", () => {
    const joined = ONCE_ALLOWED.flatMap((once) => joins.filter((join) => !join.includes("|") && join !== " & ").map((join) => `ls${join}${once}`));

    expect(joined.filter((command) => judgeCall(createCall(command))?.decision !== "deny")).toEqual([]);
  });

  it("gives every answer it gives as the one line both hosts read", () => {
    const refused = generated.map((command) => replyTo(JSON.stringify(createCall(command)))).filter((reply) => reply !== "");

    for (const reply of refused.slice(0, 500)) {
      expect(Object.keys((JSON.parse(reply) as { hookSpecificOutput: object }).hookSpecificOutput)).toEqual(["hookEventName", "permissionDecision", "permissionDecisionReason"]);
      expect(reply).not.toContain("\n");
    }
  });
});

describe("a command the hook does not read", () => {
  const deep = (levels: number, inner: string): string => `${"echo $(".repeat(levels)}${inner}${")".repeat(levels)}`;

  it("is refused when it is nested too deep and names an outward step, and is not a crash", () => {
    const answer = judgeCall(createCall(deep(20_000, "git push origin main")));

    expect(answer?.decision).toBe("deny");
    expect(answer?.reason).toContain("too long or too deeply nested");
  });

  it("is left to the host when it is nested too deep and names none", () => {
    expect(judgeCall(createCall(deep(20_000, "ls")))).toBeUndefined();
  });

  it("is read, and judged as any other, at the deepest nesting it takes", () => {
    expect(judgeCall(createCall(deep(40, "ls && git push origin main")))?.reason).toContain("joins an outward step");
    expect(judgeCall(createCall(deep(41, "ls && git push origin main")))?.reason).toContain("too long or too deeply nested");
  });

  it("is refused when it is too long and names an outward step, and left to the host when it names none", () => {
    const filler = `echo ${"x".repeat(1_000_000)}`;

    expect(judgeCall(createCall(`${filler} && git push origin worktree-a`))?.reason).toContain("too long or too deeply nested");
    expect(judgeCall(createCall(filler))).toBeUndefined();
    expect(() => parseShell(filler)).toThrow(LimitError);
    expect(parseShell(filler.slice(0, LONGEST_SCRIPT)).steps).toHaveLength(1);
  });

  it("stops reading at the bound, and does not leave that to the stack: forty levels are read, forty-one are not", () => {
    expect(parseShell(deep(DEEPEST_NESTING, "ls")).nested).toHaveLength(1);
    expect(() => parseShell(deep(DEEPEST_NESTING + 1, "ls"))).toThrow(LimitError);
    expect(() => parseShell(deep(20_000, "ls"))).toThrow(LimitError);
    expect(() => parseShell(deep(20_000, "ls"))).not.toThrow(RangeError);
  });

  it("counts how deep, not how many: a hundred substitutions side by side are read", () => {
    const beside = `echo ${"$(ls) ".repeat(100)}&& git push origin main`;

    expect(parseShell(beside).nested).toHaveLength(100);
    expect(judgeCall(createCall(beside))?.reason).toContain("joins an outward step");
  });

  it("is refused when evals are nested inside one another too deep, which needs no quoting at all", () => {
    expect(judgeCall(createCall(`${"eval ".repeat(40)}ls && git push origin main`))?.reason).toContain("joins an outward step");
    expect(judgeCall(createCall(`${"eval ".repeat(20_000)}git push origin main`))?.reason).toContain("too long or too deeply nested");
    expect(judgeCall(createCall(`${"eval ".repeat(20_000)}ls`))).toBeUndefined();
  });

  it("is one the reader itself gives up on only for a quote or a heredoc left open, which the host then judges", () => {
    expect(judgeCommand("git commit -m 'never closed && git push")).toBeUndefined();
    expect(judgeCall(createCall("git commit -m 'never closed && git push"))).toBeUndefined();
  });

  it.each([
    ["push", "git push"],
    ["gh", "gh pr merge 1"],
    ["gh at the very start", "gh"],
    ["push inside quotes", "echo 'push'"],
  ])("counts %s as naming an outward step", (_name, text) => {
    expect(mentionsOutward(text)).toBe(true);
  });

  it.each([
    ["nothing outward", "ls -la && pnpm test"],
    ["a word that only holds push", "pushd /tmp && popd"],
    ["a word that only holds gh", "echo high && ghost"],
    ["a word joined to push by a dash", "pnpm run pre-push-check"],
  ])("does not count %s", (_name, text) => {
    expect(mentionsOutward(text)).toBe(false);
  });

  it.each([
    ["not JSON", "{ not json"],
    ["JSON that is no object", "null"],
    ["a list", "[1, 2]"],
    ["a command that is a number", '{"tool_input":{"command":7}}'],
    ["a tool input that is text", '{"tool_input":"git add -A && git push"}'],
  ])("answers nothing, and exits 0, for a payload that is %s", (_name, input) => {
    expect(replyTo(input)).toBe("");

    const run = spawnSync(process.execPath, [join(ADDON, "files", HOOK_SCRIPT), RETIRED_ARGUMENT], { input, encoding: "utf8" });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("refuses the deep chain when run as a program, where it once died of a stack overflow with nothing said", () => {
    const run = spawnSync(process.execPath, [join(ADDON, "files", HOOK_SCRIPT)], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: `${deep(20_000, "true")} && git push origin main` } }),
      encoding: "utf8",
    });

    expect(run.status).toBe(0);
    expect(decisionIn(run.stdout)).toBe("deny");
  });
});

function createCall(command: string): CommandPayload {
  return { tool_name: "Bash", tool_input: { command } };
}

/** What a reply says: "none" for nothing, the decision it holds, or "not an answer". */
function decisionIn(reply: string): string {
  if (reply.trim() === "") {
    return "none";
  }

  try {
    const decision = (JSON.parse(reply) as { hookSpecificOutput?: { permissionDecision?: unknown } }).hookSpecificOutput?.permissionDecision;

    return typeof decision === "string" ? decision : "not an answer";
  } catch {
    return "not an answer";
  }
}

/** The start-up arguments in a registered command line: what follows the script. */
function argumentsOf(command: string | undefined): string[] {
  if (command === undefined) {
    throw new Error("the manifest registers no such hook");
  }

  return command.split(/\s+/).slice(2);
}
