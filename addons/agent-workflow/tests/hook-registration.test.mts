import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as forTheInstaller from "../../../scripts/lib/hook-registration.mts";
import * as forTheCheck from "../files/tools/agent-workflow/lib/hook-registration.mts";
import { ADDON, REPOSITORY } from "./support.mts";

const COMMAND = "node tools/agent-workflow/hooks/split-outward-commands.mts";

// The installer's merge and the project's check each have a copy of the file
// that decides whether a host would run a hook. Every case below is put to
// both copies.
describe.each([
  ["the installer's copy", forTheInstaller],
  ["the check's copy", forTheCheck],
])("whether a host would run a hook, by %s", (_name, { groupRuns, hostOf, isLiveCommand, runsForTool, toolsNamed }) => {
  it.each([
    ["left out", undefined, true, true],
    ["empty", "", true, true],
    ["a star", "*", true, true],
    ["the tool's name", "Bash", true, true],
    ["a list that names the tool", "Edit|Bash|Write", true, true],
    ["another tool", "Edit", false, false],
    ["a name that only begins like the tool's", "BashOutput", false, false],
    ["a name the tool's only begins like", "Bas", false, false],
    ["the name in another case", "bash", false, false],
    ["a list with commas", "Edit,Bash", true, false],
    ["a list with commas and blanks", " Edit , Bash ", true, false],
    ["a list with a blank after the name", "Edit|Bash ", true, false],
    ["a name with a dash in it", "Bash-x", false, false],
    ["a list with a dash in one name", "Bash-x,Bash", true, false],
    ["a pattern that is the whole name", "^Bash$", true, false],
    ["a pattern that matches part of the name", "as", false, false],
    ["a pattern with a dot, which matches part of the name", "B.s", true, false],
    ["a pattern for every name", ".*", true, false],
    ["a pattern for other tools", "^Notebook", false, false],
    ["a pattern that is none", "Bash(", false, false],
    ["a list with an empty part, which is a pattern for Codex", "Bash|", true, false],
    ["a number", 7, false, false],
    ["nothing", null, false, false],
    ["a list of text", ["Bash"], false, false],
    ["true", true, false, false],
  ])("reads a matcher that is %s as each host does", (_case, matcher, claude, codex) => {
    expect(runsForTool(matcher, "Bash", "claude-code")).toBe(claude);
    expect(runsForTool(matcher, "Bash", "codex")).toBe(codex);
  });

  it.each([
    ["a command hook", { type: "command", command: COMMAND }, true],
    ["one with a time limit", { type: "command", command: COMMAND, timeout: 5, statusMessage: "x" }, true],
    ["one with a time limit under a second", { type: "command", command: COMMAND, timeout: 0.5 }, true],
    ["one said not to run in the background", { type: "command", command: COMMAND, async: false }, true],
    ["another type", { type: "prompt", command: COMMAND }, false],
    ["no type", { command: COMMAND }, false],
    ["the type in another case", { type: "Command", command: COMMAND }, false],
    ["no command", { type: "command" }, false],
    ["a command that is a list", { type: "command", command: [COMMAND] }, false],
    ["a command that ends in more", { type: "command", command: `${COMMAND} || true` }, false],
    ["a command with an argument", { type: "command", command: `${COMMAND} --off` }, false],
    ["a command that is only printed", { type: "command", command: `echo ${COMMAND}` }, false],
    ["a command behind a comment sign", { type: "command", command: `# ${COMMAND}` }, false],
    ["a command with a blank after it", { type: "command", command: `${COMMAND} ` }, false],
    ["an if", { type: "command", command: COMMAND, if: "Bash(git *)" }, false],
    ["an if that is empty", { type: "command", command: COMMAND, if: "" }, false],
    ["a run in the background", { type: "command", command: COMMAND, async: true }, false],
    ["a background flag that is no yes or no", { type: "command", command: COMMAND, async: "false" }, false],
    ["a time limit of 0", { type: "command", command: COMMAND, timeout: 0 }, false],
    ["a time limit below 0", { type: "command", command: COMMAND, timeout: -1 }, false],
    ["a time limit that is text", { type: "command", command: COMMAND, timeout: "5" }, false],
    ["a time limit that is nothing", { type: "command", command: COMMAND, timeout: null }, false],
    ["text", COMMAND, false],
    ["nothing", null, false],
    ["a list", [{ type: "command", command: COMMAND }], false],
  ])("takes an entry that is %s for the hook or not", (_case, entry, runs) => {
    expect(isLiveCommand(entry, COMMAND)).toBe(runs);
    expect(groupRuns({ matcher: "Bash", hooks: [entry] }, COMMAND, "Bash", "codex")).toBe(runs);
  });

  it.each([
    ["hooks that are one entry and no list", { matcher: "Bash", hooks: { type: "command", command: COMMAND } }],
    ["no hooks", { matcher: "Bash" }],
    ["a matcher for another tool", { matcher: "Edit", hooks: [{ type: "command", command: COMMAND }] }],
    ["only another command", { matcher: "Bash", hooks: [{ type: "command", command: "node other.mts" }] }],
    ["the shape of a list", [{ type: "command", command: COMMAND }]],
    ["no shape at all", "Bash"],
  ])("does not take a group with %s for one that runs the hook", (_case, group) => {
    expect(groupRuns(group, COMMAND, "Bash", "claude-code")).toBe(false);
  });

  it("takes a group that runs the hook beside other entries", () => {
    expect(groupRuns({ hooks: ["text", { type: "prompt", command: COMMAND }, { type: "command", command: COMMAND }] }, COMMAND, "Bash", "claude-code")).toBe(true);
  });

  it("knows a file's host from where it is, and the tools a plain matcher names", () => {
    expect([".claude/settings.json", ".claude/settings.local.json", ".codex/hooks.json", "codex/hooks.json"].map(hostOf)).toEqual(["claude-code", "claude-code", "codex", "claude-code"]);
    expect(toolsNamed("Bash")).toEqual(["Bash"]);
    expect(toolsNamed("Edit|Write")).toEqual(["Edit", "Write"]);
    expect([undefined, "", "*", "Edit, Write", "^Bash$", "Bash|", 7].map(toolsNamed)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  });
});

describe("the two copies", () => {
  it("are one text, so the merge and the check cannot disagree", () => {
    const installer = readFileSync(join(REPOSITORY, "scripts/lib/hook-registration.mts"), "utf8");

    expect(readFileSync(join(ADDON, "files/tools/agent-workflow/lib/hook-registration.mts"), "utf8")).toBe(installer);
    expect(installer).toContain("export function groupRuns(");
  });
});
