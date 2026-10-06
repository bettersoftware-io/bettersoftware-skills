import { describe, expect, it } from "vitest";

import { type Json, mergeSettings, parseSettings, SettingsError } from "./lib/host-settings.mts";

describe("merging an add-on's entries into a host's settings", () => {
  it("adds a rule the list lacks, after the ones the project has", () => {
    const { merged, added } = mergeSettings(
      { permissions: { allow: ["Bash(pnpm test)"] } },
      { permissions: { allow: ["Bash(gh pr create *)", "Bash(pnpm test)"] } },
    );

    expect(merged).toEqual({ permissions: { allow: ["Bash(pnpm test)", "Bash(gh pr create *)"] } });
    expect(added).toEqual(["permissions.allow: Bash(gh pr create *)"]);
  });

  it("adds a key the project lacks, at any depth, and names each entry it brought", () => {
    const { merged, added } = mergeSettings({ model: "opus" }, { permissions: { ask: ["Bash(git push -f*)", "Bash(git push *:*)"] } });

    expect(merged).toEqual({ model: "opus", permissions: { ask: ["Bash(git push -f*)", "Bash(git push *:*)"] } });
    expect(added).toEqual(["permissions.ask: Bash(git push -f*)", "permissions.ask: Bash(git push *:*)"]);
  });

  it("keeps the project's value where both have one", () => {
    const { merged, added } = mergeSettings({ model: "opus", cleanupPeriodDays: 7 }, { model: "haiku", cleanupPeriodDays: 30 });

    expect(merged).toEqual({ model: "opus", cleanupPeriodDays: 7 });
    expect(added).toEqual([]);
  });

  it("keeps the project's value where the two are of different kinds", () => {
    expect(mergeSettings({ permissions: "all" }, { permissions: { allow: ["x"] } })).toEqual({ merged: { permissions: "all" }, added: [] });
    expect(mergeSettings({ hooks: { Stop: "none" } }, { hooks: { Stop: [createGroup("node a.mts")] } }).added).toEqual([]);
  });

  it("never removes a rule, a hook or a key the project has", () => {
    const project = {
      env: { CI: "1" },
      permissions: { allow: ["Bash(make *)"], deny: ["Bash(rm -rf *)"], ask: ["Bash(git push *--force*)", "Bash(npm publish *)"] },
      hooks: { Stop: [createGroup("node tools/arch/hooks/before-stop.mts")], PreToolUse: [createGroup("node mine.mts", "Write")] },
    };
    const { merged } = mergeSettings(project, {
      permissions: { allow: ["Bash(gh pr merge *)"], ask: ["Bash(git push *--force*)"] },
      hooks: { PreToolUse: [createGroup("node split.mts", "Bash")] },
    });

    expect(merged).toEqual({
      env: { CI: "1" },
      permissions: {
        allow: ["Bash(make *)", "Bash(gh pr merge *)"],
        deny: ["Bash(rm -rf *)"],
        ask: ["Bash(git push *--force*)", "Bash(npm publish *)"],
      },
      hooks: {
        Stop: [createGroup("node tools/arch/hooks/before-stop.mts")],
        PreToolUse: [createGroup("node mine.mts", "Write"), createGroup("node split.mts", "Bash")],
      },
    });
  });

  it("changes nothing the second time", () => {
    const wanted = { permissions: { allow: ["a", "b"], ask: ["c"] }, hooks: { PreToolUse: [createGroup("node split.mts", "Bash")] } };
    const first = mergeSettings({ permissions: { allow: ["z"] } }, wanted);
    const second = mergeSettings(first.merged, wanted);

    expect(second.added).toEqual([]);
    expect(second.merged).toEqual(first.merged);
  });

  it("does not change what it was given", () => {
    const project = { permissions: { allow: ["z"] } };

    mergeSettings(project, { permissions: { allow: ["a"] } });

    expect(project).toEqual({ permissions: { allow: ["z"] } });
  });

  it("counts a hook as there when its command is, even if the project changed the group around it", () => {
    const project = { hooks: { PreToolUse: [{ matcher: "Bash|Shell", hooks: [{ type: "command", command: "node split.mts", timeout: 30 }] }] } };
    const { merged, added } = mergeSettings(project, { hooks: { PreToolUse: [createGroup("node split.mts", "Bash")] } });

    expect(added).toEqual([]);
    expect(merged).toEqual(project);
  });

  it("adds a hook beside another event's hook with the same command, and names it by its command", () => {
    const { merged, added } = mergeSettings(
      { hooks: { PostToolUse: [createGroup("node split.mts", "Bash")] } },
      { hooks: { PreToolUse: [createGroup("node split.mts", "Bash")] } },
    );

    expect((merged as { hooks: Record<string, Json[]> }).hooks.PreToolUse).toHaveLength(1);
    expect(added).toEqual(["hooks.PreToolUse: node split.mts"]);
  });

  it("adds an object to a list only when no equal one is there", () => {
    const wanted = { servers: [{ name: "a", args: ["x", "y"] }] };

    expect(mergeSettings({ servers: [{ name: "a", args: ["x", "y"] }] }, wanted).added).toEqual([]);
    expect(mergeSettings({ servers: [{ name: "a", args: ["x"] }] }, wanted).merged).toEqual({
      servers: [
        { name: "a", args: ["x"] },
        { name: "a", args: ["x", "y"] },
      ],
    });
  });
});

describe("reading a settings file", () => {
  it("returns the object it holds", () => {
    expect(parseSettings('{ "hooks": {} }', ".claude/settings.json")).toEqual({ hooks: {} });
  });

  it("refuses text that is not JSON, and JSON that is not an object, naming the file", () => {
    expect(() => parseSettings("{ // a comment\n}", ".claude/settings.json")).toThrow(SettingsError);
    expect(() => parseSettings("{", ".claude/settings.json")).toThrow(/\.claude\/settings\.json is not valid JSON/);
    expect(() => parseSettings("[]", ".codex/hooks.json")).toThrow(/\.codex\/hooks\.json does not hold a JSON object/);
  });
});

function createGroup(command: string, matcher?: string): Json {
  return { ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command }] };
}
