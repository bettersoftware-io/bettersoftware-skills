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

  it("keeps the project's value where the two are of different kinds, and says what was left out there", () => {
    expect(mergeSettings({ permissions: "all" }, { permissions: { allow: ["x"] } })).toEqual({
      merged: { permissions: "all" },
      added: [],
      skipped: ["permissions is a value in the project and an object is needed there, so 1 entry was not merged: x"],
      kept: [],
    });
    expect(mergeSettings({ hooks: { Stop: "none" } }, { hooks: { Stop: [createGroup("node a.mts")] } })).toEqual({
      merged: { hooks: { Stop: "none" } },
      added: [],
      skipped: ["hooks.Stop is a value in the project and a list is needed there, so 1 entry was not merged: node a.mts"],
      kept: [],
    });
  });

  it.each([
    ["nothing where an object is needed", { permissions: null }, "permissions is a value in the project and an object is needed there, so 2 entries were not merged: Bash(a); Bash(b)"],
    ["text where a list is needed", { permissions: { ask: "Bash(x)" } }, "permissions.ask is a value in the project and a list is needed there, so 2 entries were not merged: Bash(a); Bash(b)"],
    ["an object where a list is needed", { permissions: { ask: {} } }, "permissions.ask is an object in the project and a list is needed there, so 2 entries were not merged: Bash(a); Bash(b)"],
    ["a list where an object is needed", { permissions: [] }, "permissions is a list in the project and an object is needed there, so 2 entries were not merged: Bash(a); Bash(b)"],
  ])("names the place and every entry left out when the project has %s", (_name, project, line) => {
    const { merged, added, skipped } = mergeSettings(project, { permissions: { ask: ["Bash(a)", "Bash(b)"] } });

    expect(merged).toEqual(project);
    expect(added).toEqual([]);
    expect(skipped).toEqual([line]);
  });

  it("names a hook that was left out by its command, and still merges everything beside it", () => {
    const { merged, added, skipped } = mergeSettings(
      { hooks: { PreToolUse: {} } },
      { permissions: { ask: ["Bash(a)"] }, hooks: { PreToolUse: [createGroup("node split.mts", "Bash")] } },
    );

    expect(merged).toEqual({ hooks: { PreToolUse: {} }, permissions: { ask: ["Bash(a)"] } });
    expect(added).toEqual(["permissions.ask: Bash(a)"]);
    expect(skipped).toEqual(["hooks.PreToolUse is an object in the project and a list is needed there, so 1 entry was not merged: node split.mts"]);
  });

  it("skips nothing where both have a plain value, or both a list, or both an object", () => {
    expect(mergeSettings({ model: "opus", a: [1], b: { c: 1 } }, { model: "haiku", a: [1], b: { c: 2 } }).skipped).toEqual([]);
    expect(mergeSettings({ model: ["opus"] }, { model: "haiku" }).skipped).toEqual([]);
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

  it("counts a hook as there under a command line the add-on registered before, leaves it as it is, and names it", () => {
    const project = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node split.mts --host=x", timeout: 30 }] }] } };
    const wanted = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node split.mts", timeout: 5 }] }] } };

    expect(mergeSettings(project, wanted, { "node split.mts --host=x": "node split.mts" })).toEqual({
      merged: project,
      added: [],
      skipped: [],
      kept: [{ has: "node split.mts --host=x", now: "node split.mts" }],
    });
  });

  it("adds the hook beside a command line nobody named as an older one, and beside one named for another hook", () => {
    const project = { hooks: { PreToolUse: [createGroup("node split.mts --host=x", "Bash")] } };
    const wanted = { hooks: { PreToolUse: [createGroup("node split.mts", "Bash")] } };

    expect(mergeSettings(project, wanted).added).toEqual(["hooks.PreToolUse: node split.mts"]);
    expect(mergeSettings(project, wanted, { "node split.mts --host=x": "node other.mts" }).added).toEqual(["hooks.PreToolUse: node split.mts"]);
  });

  it("names nothing as kept when the hook is there as it is written now, with or without the older line beside it", () => {
    const retired = { "node split.mts --host=x": "node split.mts" };
    const wanted = { hooks: { PreToolUse: [createGroup("node split.mts", "Bash")] } };
    const both = { hooks: { PreToolUse: [createGroup("node split.mts --host=x", "Bash"), createGroup("node split.mts", "Bash")] } };

    expect(mergeSettings(wanted, wanted, retired)).toEqual({ merged: wanted, added: [], skipped: [], kept: [] });
    expect(mergeSettings(both, wanted, retired)).toEqual({ merged: both, added: [], skipped: [], kept: [] });
  });

  it("does not take an older line under another event for the hook", () => {
    const project = { hooks: { PostToolUse: [createGroup("node split.mts --host=x", "Bash")], PreToolUse: [] } };
    const { added, kept } = mergeSettings(project, { hooks: { PreToolUse: [createGroup("node split.mts", "Bash")] } }, { "node split.mts --host=x": "node split.mts" });

    expect(added).toEqual(["hooks.PreToolUse: node split.mts"]);
    expect(kept).toEqual([]);
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
