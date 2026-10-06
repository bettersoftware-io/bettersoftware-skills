import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { addToProject, describe as describeResult, describeYours, listAddons, parseUnit, writeUnlessProtected } from "./add-to-project.mts";
import { InstallError, writeProjectFile } from "./lib/install.mts";

describe("adding the kit", () => {
  it("copies the kit to tools/arch, without its tests, and records what it installed", () => {
    const { repository, project } = createWorld();

    const result = addToProject({ project, unit: "kit", repository });

    expect(result.files.written.sort()).toEqual(KIT_FILES);
    expect(existsSync(join(project, "tools/arch/gates/run.test.mts"))).toBe(false);
    expect(existsSync(join(project, "tools/arch/architecture.config.example.mts"))).toBe(false);
    expect(Object.keys(readJson(project, "tools/installed.json").kit.files)).toEqual(KIT_FILES);
  });

  it("replaces an untouched file with the newer version on a second run", () => {
    const { repository, project } = createWorld();
    addToProject({ project, unit: "kit", repository });

    write(repository, "kit/gates/run.mts", "// gates, version 2\n");
    const result = addToProject({ project, unit: "kit", repository });

    expect(result.files.written).toEqual(["tools/arch/gates/run.mts"]);
    expect(result.files.unchanged.sort()).toEqual(KIT_FILES.filter((path) => path !== "tools/arch/gates/run.mts"));
    expect(read(project, "tools/arch/gates/run.mts")).toBe("// gates, version 2\n");
  });

  it("refuses to overwrite a file edited in the project, and changes nothing", () => {
    const { repository, project } = createWorld();
    addToProject({ project, unit: "kit", repository });
    write(project, "tools/arch/gates/run.mts", "// edited in the project\n");
    write(repository, "kit/gates/run.mts", "// gates, version 2\n");
    write(repository, "kit/hooks/after-edit.mts", "// hook, version 2\n");

    expect(() => addToProject({ project, unit: "kit", repository })).toThrow(/tools\/arch\/gates\/run\.mts/);

    expect(read(project, "tools/arch/gates/run.mts")).toBe("// edited in the project\n");
    expect(read(project, "tools/arch/hooks/after-edit.mts")).toBe("// hook, version 1\n");
  });

  it("overwrites an edited file when forced", () => {
    const { repository, project } = createWorld();
    addToProject({ project, unit: "kit", repository });
    write(project, "tools/arch/gates/run.mts", "// edited in the project\n");
    write(repository, "kit/gates/run.mts", "// gates, version 2\n");

    addToProject({ project, unit: "kit", repository, force: true });

    expect(read(project, "tools/arch/gates/run.mts")).toBe("// gates, version 2\n");
  });

  it("removes a file the kit no longer ships, unless it was edited", () => {
    const { repository, project } = createWorld();
    write(repository, "kit/gates/old.mts", "// dropped later\n");
    write(repository, "kit/gates/older.mts", "// dropped later too\n");
    addToProject({ project, unit: "kit", repository });
    write(project, "tools/arch/gates/older.mts", "// someone still uses this\n");

    rmSync(join(repository, "kit/gates/old.mts"));
    rmSync(join(repository, "kit/gates/older.mts"));
    const result = addToProject({ project, unit: "kit", repository });

    expect(result.files.removed).toEqual(["tools/arch/gates/old.mts"]);
    expect(result.files.kept).toEqual(["tools/arch/gates/older.mts"]);
    expect(existsSync(join(project, "tools/arch/gates/old.mts"))).toBe(false);
    expect(existsSync(join(project, "tools/arch/gates/older.mts"))).toBe(true);
  });

  it("sets up what the kit needs in a project that has none of it, and says what is left", () => {
    const { repository, project } = createWorld();

    const result = addToProject({ project, unit: "kit", repository });

    expect(result.created).toEqual(["architecture.config.mts", ".claude/settings.json", ".codex/hooks.json"]);
    expect(read(project, "architecture.config.mts")).toBe("// the example config\n");
    expect(read(project, ".claude/settings.json")).toContain("tools/arch/hooks/after-edit.mts");
    expect(readJson(project, "package.json").scripts.gates).toBe("node tools/arch/gates/run.mts");
    expect(result.notes.join("\n")).toMatch(/list this project's own packages/);
    expect(result.notes.join("\n")).toMatch(/dependency-cruiser/);
    expect(result.notes.join("\n")).toMatch(/eslint\.config\.mts/);
  });

  it("adds the quiet form of each gate the project has, and of none it does not have", () => {
    const { repository, project } = createWorld();
    const manifest = readJson(project, "package.json");
    delete manifest.scripts["gate:full"];
    write(project, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);

    const result = addToProject({ project, unit: "kit", repository });

    expect(readJson(project, "package.json").scripts["gate:fast:quiet"]).toBe("node tools/arch/gates/quiet.mts gate:fast");
    expect(readJson(project, "package.json").scripts["gate:full:quiet"]).toBeUndefined();
    expect(result.packageChanges).toEqual(["package.json: scripts.gates", "package.json: scripts.gate:fast:quiet"]);
  });

  it("leaves a quiet script the project wrote itself as it is", () => {
    const { repository, project } = createWorld();
    const manifest = readJson(project, "package.json");
    manifest.scripts["gate:full:quiet"] = "pnpm gate:full > /dev/null";
    write(project, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);

    addToProject({ project, unit: "kit", repository });

    expect(readJson(project, "package.json").scripts["gate:full:quiet"]).toBe("pnpm gate:full > /dev/null");
  });

  it("leaves the project's own settings alone, and says how to merge the hooks in", () => {
    const { repository, project } = createWorld();
    write(project, ".claude/settings.json", '{ "permissions": {} }\n');
    write(project, "architecture.config.mts", "// the project's own config\n");

    const result = addToProject({ project, unit: "kit", repository });

    expect(read(project, ".claude/settings.json")).toBe('{ "permissions": {} }\n');
    expect(read(project, "architecture.config.mts")).toBe("// the project's own config\n");
    expect(result.created).toEqual([".codex/hooks.json"]);
    expect(result.notes.join("\n")).toMatch(/\.claude\/settings\.json exists and does not run the hooks/);
  });

  it("goes on, and says so, when the host does not let it write a hook file", () => {
    const { repository, project } = createWorld();

    // Codex's sandbox keeps `.codex` read-only, so an agent cannot install its own hooks.
    mkdirSync(join(project, ".codex"));
    chmodSync(join(project, ".codex"), 0o555);

    const result = addToProject({ project, unit: "kit", repository });

    expect(result.created).toEqual(["architecture.config.mts", ".claude/settings.json"]);
    expect(existsSync(join(project, "tools/arch/gates/run.mts"))).toBe(true);
    expect(result.notes.join("\n")).toMatch(
      /\.codex\/hooks\.json could not be written.*copy tools\/arch\/hooks\/codex\.hooks\.json/s,
    );
  });

  it("names a lint dependency the project has not installed, with the command that adds it", () => {
    const { repository, project } = createWorld();
    const manifest = readJson(project, "package.json");
    manifest.devDependencies = { "dependency-cruiser": "^18.0.0" };
    write(project, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
    write(project, "eslint.config.mts", "export default [];\n");
    write(project, "architecture.config.mts", "// the project's own config\n");

    const result = addToProject({ project, unit: "kit", repository });

    expect(result.notes).toEqual([
      "install eslint-plugin-react-hooks as a dev dependency (pnpm add -D -w eslint-plugin-react-hooks@^7.1.1): the rules for React code in a client package need it, and the lint stops and says so without it",
    ]);
  });

  it("names each check of the kit that no script of the project runs, with the script to add", () => {
    const { repository, project } = createWorld();
    const manifest = readJson(project, "package.json");
    manifest.devDependencies = { "dependency-cruiser": "^18.0.0", "eslint-plugin-react-hooks": "^7.1.1" };
    manifest.scripts = { gates: "node tools/arch/gates/run.mts", "gate:fast": "pnpm gates && pnpm lint" };
    write(project, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
    write(project, "eslint.config.mts", "export default [];\n");
    write(project, "architecture.config.mts", "// the project's own config\n");

    expect(addToProject({ project, unit: "kit", repository }).notes).toEqual([
      expect.stringContaining('add "check:react-policies": "node tools/arch/check-react-policies.mts"'),
      expect.stringContaining('add "check:compiler": "node tools/arch/check-compiler.mts" to the scripts, and `pnpm check:compiler` to gate:fast'),
    ]);

    // Run from inside another script counts: what matters is that something runs it.
    manifest.scripts["gate:fast"] = "pnpm gates && node tools/arch/check-compiler.mts";
    write(project, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);

    const result = addToProject({ project, unit: "kit", repository });

    expect(result.notes).toEqual([
      'add "check:react-policies": "node tools/arch/check-react-policies.mts" to the scripts, and `pnpm check:react-policies` to gate:fast: it checks that every package that imports React is under the lint rules for its role, and reports a skip where there is nothing to judge',
    ]);
  });

  it("has nothing left to say once the project is set up", () => {
    const { repository, project } = createWorld();
    const manifest = readJson(project, "package.json");
    manifest.devDependencies = { "dependency-cruiser": "^18.0.0", "eslint-plugin-react-hooks": "^7.1.1" };
    write(project, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
    write(project, "eslint.config.mts", "export default [];\n");
    write(project, "architecture.config.mts", "// the project's own config\n");
    addToProject({ project, unit: "kit", repository });

    const result = addToProject({ project, unit: "kit", repository });

    expect(result.created).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.packageChanges).toEqual([]);
  });

  it("never deletes outside the project, whatever the project's record says", () => {
    const { repository, project } = createWorld();
    addToProject({ project, unit: "kit", repository });
    write(project, "../outside.txt", "not the project's file\n");
    const record = readJson(project, "tools/installed.json");
    // A record that claims the kit installed a file outside the project, with
    // that file's true hash, so it looks untouched and safe to remove.
    record.kit.files["../outside.txt"] = createHash("sha256").update("not the project's file\n").digest("hex");
    write(project, "tools/installed.json", JSON.stringify(record));

    expect(() => addToProject({ project, unit: "kit", repository })).toThrow(/outside the project/);

    expect(existsSync(join(project, "../outside.txt"))).toBe(true);
  });

  it("never writes through a link that leads out of the project", () => {
    const { repository, project } = createWorld();
    const elsewhere = join(project, "..", "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(join(project, "tools"));
    symlinkSync(elsewhere, join(project, "tools", "arch"));

    expect(() => addToProject({ project, unit: "kit", repository })).toThrow(/outside the project/);

    expect(existsSync(join(elsewhere, "gates", "run.mts"))).toBe(false);
  });

  it("never creates a file through a link that points at nothing yet", () => {
    const { repository, project } = createWorld();
    const outside = join(project, "..", "created-outside.mts");
    mkdirSync(join(project, "tools", "arch", "gates"), { recursive: true });
    symlinkSync(outside, join(project, "tools", "arch", "gates", "run.mts"));

    expect(() => addToProject({ project, unit: "kit", repository })).toThrow(/outside the project/);

    expect(existsSync(outside)).toBe(false);
  });

  it("never sets up a hook file through a link that leads out of the project", () => {
    const { repository, project } = createWorld();
    const elsewhere = join(project, "..", "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(project, ".claude"));

    expect(() => addToProject({ project, unit: "kit", repository })).toThrow(/outside the project/);

    expect(existsSync(join(elsewhere, "settings.json"))).toBe(false);
    expect(existsSync(join(project, "tools", "arch"))).toBe(false);
  });

  it("refuses a folder that is not a project", () => {
    const { repository } = createWorld();
    const empty = mkdtempSync(join(tmpdir(), "not-a-project-"));
    onTestFinished(() => {
      rmSync(empty, { recursive: true, force: true });
    });

    expect(() => addToProject({ project: empty, unit: "kit", repository })).toThrow(InstallError);
  });
});

describe("what a kit update leaves to the project", () => {
  it("says nothing the first time the kit is installed", () => {
    const { repository, project } = createWorld();
    withStarterInstructions(repository, "# Working here\n");

    const result = addToProject({ project, unit: "kit", repository });

    expect(result.yours).toEqual([]);
    expect(result.newGates).toEqual([]);
    expect(describeYours(result)).toEqual([]);
  });

  it("says nothing about a file whose template did not change, whatever else the update brought", () => {
    const { repository, project } = createWorldWithKit();
    write(project, ".claude/settings.json", '{ "permissions": {}, "hooks": "node tools/arch/hooks/after-edit.mts" }\n');
    write(repository, "kit/gates/run.mts", "// gates, version 2\n");

    const result = addToProject({ project, unit: "kit", repository });

    expect(result.files.written).toEqual(["tools/arch/gates/run.mts"]);
    expect(result.yours).toEqual([]);
  });

  it("names a file that is still the old template, with the command that takes the new one, and does not take it itself", () => {
    const { repository, project } = createWorldWithKit();
    write(repository, "kit/hooks/claude.settings.json", '{ "hooks": "node tools/arch/hooks/after-edit.mts", "timeout": 600 }\n');

    const result = addToProject({ project, unit: "kit", repository });

    expect(result.yours).toEqual([
      {
        owned: ".claude/settings.json",
        template: "tools/arch/hooks/claude.settings.json",
        state: "untouched",
        lines: ['- { "hooks": "node tools/arch/hooks/after-edit.mts" }', '+ { "hooks": "node tools/arch/hooks/after-edit.mts", "timeout": 600 }'],
      },
    ]);
    expect(read(project, ".claude/settings.json")).toBe(CLAUDE_SETTINGS);
    expect(describeYours(result)).toEqual([
      "",
      "Yours to change. These files are the project's, so the update did not touch them:",
      "  - .claude/settings.json: yours is still the old template, word for word. Take the new one:",
      "      cp tools/arch/hooks/claude.settings.json .claude/settings.json",
      "      What changed in the template:",
      '        - { "hooks": "node tools/arch/hooks/after-edit.mts" }',
      '        + { "hooks": "node tools/arch/hooks/after-edit.mts", "timeout": 600 }',
    ]);
  });

  it("names a file the project edited, shows what changed in its template, and leaves the edit alone", () => {
    const { repository, project } = createWorldWithKit();
    const edited = '{ "permissions": {}, "hooks": "node tools/arch/hooks/after-edit.mts" }\n';
    write(project, ".claude/settings.json", edited);
    write(repository, "kit/hooks/claude.settings.json", '{ "hooks": "node tools/arch/hooks/after-edit.mts", "timeout": 600 }\n');

    const result = addToProject({ project, unit: "kit", repository });

    expect(result.yours.map(({ owned, state }) => ({ owned, state }))).toEqual([{ owned: ".claude/settings.json", state: "edited" }]);
    expect(read(project, ".claude/settings.json")).toBe(edited);
    expect(describeYours(result).slice(2, 5)).toEqual([
      "  - .claude/settings.json: yours has changes of its own, so it was left as it is. Make this change in it by hand.",
      "      The whole template is tools/arch/hooks/claude.settings.json",
      "      What changed in the template:",
    ]);
  });

  it("says it once: a second update with the same kit has nothing to add", () => {
    const { repository, project } = createWorldWithKit();
    write(repository, "kit/hooks/claude.settings.json", '{ "hooks": "node tools/arch/hooks/after-edit.mts", "timeout": 600 }\n');
    addToProject({ project, unit: "kit", repository });

    expect(addToProject({ project, unit: "kit", repository }).yours).toEqual([]);
  });

  it("does not ask for a change to a file it has just written from the new template", () => {
    const { repository, project } = createWorldWithKit();
    rmSync(join(project, ".codex/hooks.json"));
    write(repository, "kit/hooks/codex.hooks.json", '{ "hooks": "node tools/arch/hooks/after-edit.mts", "timeout": 600 }\n');

    const result = addToProject({ project, unit: "kit", repository });

    expect(result.created).toEqual([".codex/hooks.json"]);
    expect(result.yours).toEqual([]);
  });

  it("covers AGENTS.md, from the starter's, kept in the project's own package scope", () => {
    const { repository, project } = createWorld();
    withStarterInstructions(repository, "# Working here\n\nRun `pnpm --filter @app/web test`.\nStop on a red gate.\n");
    addToProject({ project, unit: "kit", repository });
    write(project, "AGENTS.md", read(project, "tools/arch/templates/AGENTS.md.txt"));
    withStarterInstructions(repository, "# Working here\n\nRun `pnpm --filter @app/web test`.\nStop on a red gate, and say so.\n");

    const result = addToProject({ project, unit: "kit", repository });

    expect(read(project, "tools/arch/templates/AGENTS.md.txt")).toContain("pnpm --filter @acme/web test");
    expect(result.yours).toEqual([
      {
        owned: "AGENTS.md",
        template: "tools/arch/templates/AGENTS.md.txt",
        state: "untouched",
        lines: ["- Stop on a red gate.", "+ Stop on a red gate, and say so."],
      },
    ]);
    expect(read(project, "AGENTS.md")).toContain("Stop on a red gate.\n");
  });

  it("covers architecture.config.mts, from the kit's example, and says when the project has none under that name", () => {
    const { repository, project } = createWorldWithKit();
    write(repository, "kit/architecture.config.example.mts", "// the example config\n// typesOnly: a package of types\n");
    const edited = addToProject({ project, unit: "kit", repository });

    expect(edited.yours).toEqual([
      {
        owned: "architecture.config.mts",
        template: "tools/arch/templates/architecture.config.mts.txt",
        state: "untouched",
        lines: ["+ // typesOnly: a package of types"],
      },
    ]);

    rmSync(join(project, "architecture.config.mts"));
    write(project, "architecture.config.mjs", "// a project on an older runtime\n");
    write(repository, "kit/architecture.config.example.mts", "// the example config\n");
    const absent = addToProject({ project, unit: "kit", repository });

    expect(absent.yours.map(({ owned, state }) => ({ owned, state }))).toEqual([{ owned: "architecture.config.mts", state: "absent" }]);
    expect(describeYours(absent)[2]).toBe(
      "  - architecture.config.mts: this project has none. If it should, the template is tools/arch/templates/architecture.config.mts.txt",
    );
  });

  it("names a gate the update brought, with the options of the architecture config it reads", () => {
    const { repository, project } = createWorld();
    write(repository, "kit/gates/gates.json", JSON.stringify({ structure: ["packages"] }));
    addToProject({ project, unit: "kit", repository });
    write(repository, "kit/gates/gates.json", JSON.stringify({ structure: ["packages"], "types-only": ["typesOnly"], "agent-docs": [] }));

    const result = addToProject({ project, unit: "kit", repository });

    expect(result.newGates).toEqual([
      { name: "types-only", options: ["typesOnly"] },
      { name: "agent-docs", options: [] },
    ]);
    expect(describeYours(result)).toEqual([
      "",
      "Yours to change. These files are the project's, so the update did not touch them:",
      "  - architecture.config.mts: the kit has a new gate, types-only. It reads typesOnly: set what this project needs.",
      "      tools/arch/README.md says what it fails on. Run pnpm gates to see what it says here.",
      "  - architecture.config.mts: the kit has a new gate, agent-docs. It reads no option of this file.",
      "      tools/arch/README.md says what it fails on. Run pnpm gates to see what it says here.",
    ]);
    expect(addToProject({ project, unit: "kit", repository }).newGates).toEqual([]);
  });

  it("does not call every gate new in a project whose kit had no list of them, or one that cannot be read", () => {
    const { repository, project } = createWorldWithKit();
    write(repository, "kit/gates/gates.json", JSON.stringify({ structure: ["packages"] }));

    expect(addToProject({ project, unit: "kit", repository }).newGates).toEqual([]);

    write(repository, "kit/gates/gates.json", "not json");
    write(repository, "kit/hooks/after-edit.mts", "// hook, version 2\n");

    expect(addToProject({ project, unit: "kit", repository }).newGates).toEqual([]);
  });
});

describe("what an add-on update leaves to the project", () => {
  it("says nothing when the add-on is first added", () => {
    const { repository, project } = createWorldWithKit();
    withStartingFiles(repository);

    expect(addToProject({ project, unit: "demo", repository }).yours).toEqual([]);
  });

  it("names a starting file whose template changed, whether the project edited it or not, and overwrites neither", () => {
    const { repository, project } = createWorldWithKit();
    withStartingFiles(repository);
    write(repository, "addons/demo/files/tools/demo.config.mts", "// settings, as shipped\n");
    write(repository, "addons/demo/addon.json", JSON.stringify({ ...readJson(repository, "addons/demo/addon.json"), startingFiles: ["packages/web/tests/scenarios.ts", "packages/web/tests/goldens/", "tools/demo.config.mts"] }));
    addToProject({ project, unit: "demo", repository });
    write(project, "packages/web/tests/scenarios.ts", "// the project's own scenarios\n");
    write(repository, "addons/demo/files/packages/web/tests/scenarios.ts", "// scenarios, version 2\n");
    write(repository, "addons/demo/files/tools/demo.config.mts", "// settings, version 2\n");

    const result = addToProject({ project, unit: "demo", repository });

    expect(result.yours).toEqual([
      {
        owned: "packages/web/tests/scenarios.ts",
        template: "tools/templates/demo.packages__web__tests__scenarios.ts.txt",
        state: "edited",
        lines: ["- // scenarios, as shipped", "+ // scenarios, version 2"],
      },
      {
        owned: "tools/demo.config.mts",
        template: "tools/templates/demo.tools__demo.config.mts.txt",
        state: "untouched",
        lines: ["- // settings, as shipped", "+ // settings, version 2"],
      },
    ]);
    expect(read(project, "packages/web/tests/scenarios.ts")).toBe("// the project's own scenarios\n");
    expect(read(project, "tools/demo.config.mts")).toBe("// settings, as shipped\n");
  });

  it("keeps no copy of a starting file that is not text, so a golden image is never compared", () => {
    const { repository, project } = createWorldWithKit();
    withStartingFiles(repository);
    addToProject({ project, unit: "demo", repository });
    write(repository, "addons/demo/files/packages/web/tests/goldens/a.png", "another image");

    const result = addToProject({ project, unit: "demo", repository });

    expect(Object.keys(readJson(project, "tools/installed.json").demo.files).filter((path) => path.startsWith("tools/templates/"))).toEqual([
      "tools/templates/demo.packages__web__tests__scenarios.ts.txt",
    ]);
    expect(result.yours).toEqual([]);
  });
});

describe("writing a project file", () => {
  it("is refused through a link on its own, so a write that skips the checks up front is still safe", () => {
    const { project } = createWorld();
    const elsewhere = join(project, "..", "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(project, "linked"));

    expect(() => {
      writeProjectFile(project, "linked/file.txt", "content\n");
    }).toThrow(/outside the project/);
    expect(existsSync(join(elsewhere, "file.txt"))).toBe(false);

    writeProjectFile(project, "plain/file.txt", "content\n");
    expect(read(project, "plain/file.txt")).toBe("content\n");
  });
});

describe("writing a host's settings file", () => {
  it("gives way to the host's refusal, and to nothing else: a link out of the project is still an error", () => {
    const { project } = createWorld();
    const outside = mkdtempSync(join(tmpdir(), "outside-"));

    onTestFinished(() => {
      rmSync(outside, { recursive: true, force: true });
    });
    symlinkSync(outside, join(project, ".codex"));

    expect(() => writeUnlessProtected(project, ".codex/hooks.json", "{}")).toThrow(InstallError);
    expect(existsSync(join(outside, "hooks.json"))).toBe(false);
  });
});

describe("adding an add-on", () => {
  it("copies its files with the project's package scope in place of the starter's", () => {
    const { repository, project } = createWorldWithKit();

    const result = addToProject({ project, unit: "demo", repository });

    expect(result.files.written.sort()).toEqual(["packages/web/tests/demo.ts", "tools/demo/check.mts"]);
    expect(read(project, "packages/web/tests/demo.ts")).toBe('import { thing } from "@acme/web";\n');
    expect(result.verify).toBe("pnpm --filter @acme/web demo");
  });

  it("adds its scripts and dependencies to the root and to every package it names", () => {
    const { repository, project } = createWorldWithKit();

    addToProject({ project, unit: "demo", repository });

    expect(readJson(project, "package.json").scripts.demo).toBe("node tools/demo/check.mts");
    expect(readJson(project, "package.json").devDependencies).toEqual({ "demo-tool": "^1.0.0" });
    expect(readJson(project, "packages/web/package.json").scripts["test:demo"]).toBe("demo --filter @acme/web");
    expect(readJson(project, "packages/api/package.json").scripts["test:demo"]).toBe("demo --filter @acme/web");
  });

  it("keeps a package's dependencies in order, as a person adding one by hand would", () => {
    const { repository, project } = createWorldWithKit();
    const manifest = readJson(project, "package.json");

    manifest.devDependencies = { "a-tool": "^1.0.0", "z-tool": "^1.0.0" };
    manifest.scripts = { ...manifest.scripts, zebra: "true" };
    write(project, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);

    addToProject({ project, unit: "demo", repository });

    expect(Object.keys(readJson(project, "package.json").devDependencies)).toEqual(["a-tool", "demo-tool", "z-tool"]);
    // Scripts are in the order their author chose, and stay so.
    expect(Object.keys(readJson(project, "package.json").scripts).at(-1)).toBe("demo");
  });

  it("joins the project's gates once, however often it is added", () => {
    const { repository, project } = createWorldWithKit();

    addToProject({ project, unit: "demo", repository });
    addToProject({ project, unit: "demo", repository });

    expect(readJson(project, "package.json").scripts["gate:fast"]).toBe("pnpm gates && pnpm lint && pnpm demo");
    expect(readJson(project, "package.json").scripts["gate:full"]).toBe("pnpm gate:fast && pnpm test && pnpm demo:slow");
  });

  it("appends its section to AGENTS.md once, and replaces it when the section changes", () => {
    const { repository, project } = createWorldWithKit();

    expect(addToProject({ project, unit: "demo", repository }).agents).toBe("added");
    expect(addToProject({ project, unit: "demo", repository }).agents).toBe("unchanged");

    write(repository, "addons/demo/AGENTS.section.md", "## Demo\n\nThe second wording.\n");

    expect(addToProject({ project, unit: "demo", repository }).agents).toBe("updated");
    expect(read(project, "AGENTS.md")).toBe(
      "# Working here\n\nThe project's own text.\n\n<!-- add-on: demo -->\n## Demo\n\nThe second wording.\n<!-- /add-on: demo -->\n",
    );
  });

  it("writes a starting file once, then leaves it to the project", () => {
    const { repository, project } = createWorldWithKit();
    withStartingFiles(repository);
    addToProject({ project, unit: "demo", repository });
    expect(read(project, "packages/web/tests/scenarios.ts")).toBe("// scenarios, as shipped\n");

    write(project, "packages/web/tests/scenarios.ts", "// the project's own scenarios\n");
    write(project, "packages/web/tests/goldens/a.png", "the project's own image");
    write(repository, "addons/demo/files/packages/web/tests/scenarios.ts", "// scenarios, version 2\n");
    write(repository, "addons/demo/files/tools/demo/check.mts", "// the add-on's check, version 2\n");
    const result = addToProject({ project, unit: "demo", repository });

    expect(read(project, "packages/web/tests/scenarios.ts")).toBe("// the project's own scenarios\n");
    expect(read(project, "packages/web/tests/goldens/a.png")).toBe("the project's own image");
    expect(read(project, "tools/demo/check.mts")).toBe("// the add-on's check, version 2\n");
    expect(result.files.written).toEqual(["tools/demo/check.mts", "tools/templates/demo.packages__web__tests__scenarios.ts.txt"]);
  });

  it("does not bring back a starting file the project deleted", () => {
    const { repository, project } = createWorldWithKit();
    withStartingFiles(repository);
    addToProject({ project, unit: "demo", repository });
    rmSync(join(project, "packages/web/tests/goldens/a.png"));

    addToProject({ project, unit: "demo", repository });

    expect(existsSync(join(project, "packages/web/tests/goldens/a.png"))).toBe(false);
  });

  it("refuses a script the project already defines differently, and changes nothing", () => {
    const { repository, project } = createWorldWithKit();
    const manifest = readJson(project, "package.json");
    manifest.scripts.demo = "echo mine";
    write(project, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => addToProject({ project, unit: "demo", repository })).toThrow(/scripts\.demo is "echo mine"/);

    expect(existsSync(join(project, "tools/demo/check.mts"))).toBe(false);
    expect(readJson(project, "package.json").scripts["gate:fast"]).toBe("pnpm gates && pnpm lint");
    expect(read(project, "AGENTS.md")).not.toContain("add-on: demo");
  });

  it("never writes its section through an AGENTS.md that is a link out of the project", () => {
    const { repository, project } = createWorldWithKit();
    write(project, "../shared-agents.md", "someone else's file\n");
    rmSync(join(project, "AGENTS.md"));
    symlinkSync(join(project, "..", "shared-agents.md"), join(project, "AGENTS.md"));

    expect(() => addToProject({ project, unit: "demo", repository })).toThrow(/outside the project/);

    expect(read(project, "../shared-agents.md")).toBe("someone else's file\n");
    expect(existsSync(join(project, "tools/demo/check.mts"))).toBe(false);
  });

  it("never edits a package.json that is a link out of the project", () => {
    const { repository, project } = createWorldWithKit();
    write(project, "../other-package.json", '{ "name": "@acme/api" }\n');
    rmSync(join(project, "packages/api/package.json"));
    symlinkSync(join(project, "..", "other-package.json"), join(project, "packages/api/package.json"));

    expect(() => addToProject({ project, unit: "demo", repository })).toThrow(/outside the project/);

    expect(read(project, "../other-package.json")).toBe('{ "name": "@acme/api" }\n');
    expect(existsSync(join(project, "tools/demo/check.mts"))).toBe(false);
  });

  it("refuses a project that does not have the kit", () => {
    const { repository, project } = createWorld();

    expect(() => addToProject({ project, unit: "demo", repository })).toThrow(/does not have the kit/);
  });

  it("passes on the command an add-on asks to be run once it is installed", () => {
    const { repository, project } = createWorldWithKit();
    const manifest = readJson(repository, "addons/demo/addon.json");

    expect(addToProject({ project, unit: "demo", repository }).firstRun).toBeUndefined();

    manifest.firstRun = "pnpm demo:fix";
    write(repository, "addons/demo/addon.json", JSON.stringify(manifest));

    expect(addToProject({ project, unit: "demo", repository }).firstRun).toBe("pnpm demo:fix");
  });

  it("merges its entries into a host's settings file, keeps what the project had, and says what it added", () => {
    const { repository, project } = createWorldWithKit();
    withHostSettings(repository);
    write(project, ".claude/settings.json", `${JSON.stringify(createProjectSettings())}\n`);

    const result = addToProject({ project, unit: "demo", repository });

    expect(readJson(project, ".claude/settings.json")).toEqual({
      model: "opus",
      permissions: { allow: ["Bash(make *)", "Bash(gh pr create *)"], deny: ["Bash(rm -rf *)"] },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "node tools/arch/hooks/before-stop.mts" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node tools/demo/hook.mts" }] }],
      },
    });
    expect(result.settingsChanges).toEqual([
      ".claude/settings.json: permissions.allow: Bash(gh pr create *)",
      ".claude/settings.json: hooks.PreToolUse: node tools/demo/hook.mts",
    ]);
    expect(result.notes).toEqual([]);
  });

  it("leaves a host's settings file byte for byte as it was when it already has every entry", () => {
    const { repository, project } = createWorldWithKit();
    withHostSettings(repository);
    write(project, ".claude/settings.json", `${JSON.stringify(createProjectSettings())}\n`);
    addToProject({ project, unit: "demo", repository });

    // The project lays its file out its own way; a run with nothing to add must not rewrite it.
    const edited = JSON.stringify(readJson(project, ".claude/settings.json"), null, 8);
    write(project, ".claude/settings.json", edited);

    const again = addToProject({ project, unit: "demo", repository });

    expect(read(project, ".claude/settings.json")).toBe(edited);
    expect(again.settingsChanges).toEqual([]);
  });

  it("creates a host's settings file that is not there, with its entries alone", () => {
    const { repository, project } = createWorldWithKit();
    withHostSettings(repository);
    rmSync(join(project, ".claude/settings.json"));

    addToProject({ project, unit: "demo", repository });

    expect(readJson(project, ".claude/settings.json")).toEqual(readJson(repository, "addons/demo/addon.json").hostSettings[".claude/settings.json"]);
  });

  it("leaves a settings file it cannot read as it is, changes nothing else in it, and says what to add by hand", () => {
    const { repository, project } = createWorldWithKit();
    withHostSettings(repository);
    write(project, ".claude/settings.json", "{ // the project's comment\n}\n");

    const result = addToProject({ project, unit: "demo", repository });

    expect(read(project, ".claude/settings.json")).toBe("{ // the project's comment\n}\n");
    expect(result.settingsChanges).toEqual([]);
    expect(result.notes.join("\n")).toMatch(/\.claude\/settings\.json is not valid JSON.*nothing was merged.*Bash\(gh pr create \*\)/s);
  });

  it("goes on, and says what is missing, when the host does not let its settings file be written", () => {
    const { repository, project } = createWorldWithKit();
    withHostSettings(repository);
    chmodSync(join(project, ".claude/settings.json"), 0o444);
    chmodSync(join(project, ".claude"), 0o555);
    onTestFinished(() => {
      chmodSync(join(project, ".claude"), 0o755);
    });

    const result = addToProject({ project, unit: "demo", repository });

    expect(existsSync(join(project, "tools/demo/check.mts"))).toBe(true);
    expect(result.settingsChanges).toEqual([]);
    expect(result.notes.join("\n")).toMatch(/\.claude\/settings\.json could not be written.*run this script again.*Bash\(gh pr create \*\)/s);
  });

  it("never merges into a settings file that is a link out of the project", () => {
    const { repository, project } = createWorldWithKit();
    withHostSettings(repository);
    const outside = mkdtempSync(join(tmpdir(), "outside-"));

    onTestFinished(() => {
      rmSync(outside, { recursive: true, force: true });
    });
    writeFileSync(join(outside, "settings.json"), "{}\n");
    rmSync(join(project, ".claude"), { recursive: true });
    symlinkSync(outside, join(project, ".claude"));

    expect(() => addToProject({ project, unit: "demo", repository })).toThrow(InstallError);
    expect(readFileSync(join(outside, "settings.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(project, "tools/demo/check.mts"))).toBe(false);
  });

  it("installs the rest, and records nothing for a file the host keeps it from writing in its own folder", () => {
    const { repository, project } = createWorldWithKit();
    write(repository, "addons/demo/files/.agents/skills/demo/SKILL.md", "# a skill\n");

    // Codex's sandbox keeps `.agents` read-only, so an agent cannot install skills for itself.
    mkdirSync(join(project, ".agents"));
    chmodSync(join(project, ".agents"), 0o555);
    onTestFinished(() => {
      chmodSync(join(project, ".agents"), 0o755);
    });

    const result = addToProject({ project, unit: "demo", repository });

    expect(result.files.refused).toEqual([".agents/skills/demo/SKILL.md"]);
    expect(result.files.written.sort()).toEqual(["packages/web/tests/demo.ts", "tools/demo/check.mts"]);
    expect(Object.keys(readJson(project, "tools/installed.json").demo.files)).not.toContain(".agents/skills/demo/SKILL.md");
    expect(result.notes.join("\n")).toMatch(/\.agents\/skills\/demo\/SKILL\.md could not be written.*run this script again/s);

    chmodSync(join(project, ".agents"), 0o755);

    expect(addToProject({ project, unit: "demo", repository }).files.written).toEqual([".agents/skills/demo/SKILL.md"]);
  });

  it("still stops when a file outside a host's folder cannot be written", () => {
    const { repository, project } = createWorldWithKit();

    mkdirSync(join(project, "tools/demo"), { recursive: true });
    chmodSync(join(project, "tools/demo"), 0o555);
    onTestFinished(() => {
      chmodSync(join(project, "tools/demo"), 0o755);
    });

    expect(() => addToProject({ project, unit: "demo", repository })).toThrow(/EACCES|EPERM/);
  });

  it("says which add-ons are recommended, from each one's own manifest", () => {
    const { repository } = createWorld();
    const manifest = readJson(repository, "addons/demo/addon.json");

    expect(listAddons(repository)).toEqual([{ name: "demo", summary: manifest.summary, recommended: false }]);

    manifest.recommended = true;
    write(repository, "addons/demo/addon.json", JSON.stringify(manifest));

    expect(listAddons(repository)).toEqual([{ name: "demo", summary: manifest.summary, recommended: true }]);
  });

  it("names the add-ons that exist when asked for one that does not", () => {
    const { repository, project } = createWorldWithKit();

    expect(() => addToProject({ project, unit: "nope", repository })).toThrow(/available: demo/);
    expect(listAddons(repository)).toEqual([{ name: "demo", summary: "A demo add-on.", recommended: false }]);
  });

  it("asks for the scope when the project's packages do not share one", () => {
    const { repository, project } = createWorldWithKit();
    write(project, "packages/api/package.json", '{ "name": "@other/api" }\n');

    expect(() => addToProject({ project, unit: "demo", repository })).toThrow(/pass --scope/);
    expect(addToProject({ project, unit: "demo", repository, scope: "@acme" }).files.written).toHaveLength(2);
  });
});

describe("an add-on with a choice", () => {
  const A = ".github/bot-a.yml";
  const B = ".github/bot-b.json5";

  it("gives the default option's files when none is named, and no other option's", () => {
    const { repository, project } = createWorldWithChoice();

    const result = addToProject({ project, unit: "demo", repository });

    expect(read(project, A)).toBe("# bot a, for @acme/web\n");
    expect(existsSync(join(project, B))).toBe(false);
    expect(result.choice).toBe("bot-a");
    expect(result.created).toEqual([A]);
    expect(readJson(project, "tools/installed.json").demo.choice).toBe("bot-a");
  });

  it("gives the option that is named, with the project's scope in it, and not the default's files", () => {
    const { repository, project } = createWorldWithChoice();

    const result = addToProject({ project, unit: "demo:bot-b", repository });

    expect(read(project, B)).toBe("// bot b, for @acme/web\n");
    expect(existsSync(join(project, A))).toBe(false);
    expect(result.unit).toBe("demo");
    expect(readJson(project, "tools/installed.json").demo.choice).toBe("bot-b");
    expect(readJson(project, "tools/installed.json")["demo:bot-b"]).toBeUndefined();
  });

  it("keeps the option the project has when the add-on is updated by its name alone", () => {
    const { repository, project } = createWorldWithChoice();
    addToProject({ project, unit: "demo:bot-b", repository });
    write(repository, "addons/demo/files/tools/demo/check.mts", "// the add-on's check, version 2\n");

    const result = addToProject({ project, unit: "demo", repository });

    expect(result.choice).toBe("bot-b");
    expect(result.created).toEqual([]);
    expect(existsSync(join(project, A))).toBe(false);
    expect(read(project, B)).toBe("// bot b, for @acme/web\n");
  });

  it("moves to another option: removes the file the project never changed, and writes the new one", () => {
    const { repository, project } = createWorldWithChoice();
    addToProject({ project, unit: "demo", repository });

    const result = addToProject({ project, unit: "demo:bot-b", repository });

    expect(existsSync(join(project, A))).toBe(false);
    expect(read(project, B)).toBe("// bot b, for @acme/web\n");
    expect(result.choiceRemoved).toEqual([A]);
    expect(result.created).toEqual([B]);
    expect(result.notes).toEqual([]);
    expect(Object.keys(readJson(project, "tools/installed.json").demo.files).filter((path) => path.startsWith("tools/templates/"))).toEqual([
      "tools/templates/demo..github__bot-b.json5.txt",
    ]);
  });

  it("moves back the same way", () => {
    const { repository, project } = createWorldWithChoice();
    addToProject({ project, unit: "demo:bot-b", repository });

    const result = addToProject({ project, unit: "demo:bot-a", repository });

    expect(existsSync(join(project, B))).toBe(false);
    expect(read(project, A)).toBe("# bot a, for @acme/web\n");
    expect(result.choiceRemoved).toEqual([B]);
    expect(readJson(project, "tools/installed.json").demo.choice).toBe("bot-a");
  });

  it("leaves a file the project changed where it is, writes the new option beside it, and says what to do", () => {
    const { repository, project } = createWorldWithChoice();
    addToProject({ project, unit: "demo", repository });
    write(project, A, "# bot a, with the project's own schedule\n");

    const result = addToProject({ project, unit: "demo:bot-b", repository });

    expect(read(project, A)).toBe("# bot a, with the project's own schedule\n");
    expect(read(project, B)).toBe("// bot b, for @acme/web\n");
    expect(result.choiceRemoved).toEqual([]);
    expect(result.notes).toEqual([
      `${A} is from the option "bot-a", which "bot-b" replaces. It was changed in this project, so it was left where it is. Move what you changed to the new option's file, then delete it: while both are there, both options are in force`,
    ]);
  });

  it("leaves a file it has no installed copy to compare with, and says that it cannot tell", () => {
    const { repository, project } = createWorldWithChoice();
    addToProject({ project, unit: "demo", repository });
    rmSync(join(project, "tools/templates/demo..github__bot-a.yml.txt"));

    const result = addToProject({ project, unit: "demo:bot-b", repository });

    expect(existsSync(join(project, A))).toBe(true);
    expect(result.notes.join("\n")).toContain("No copy of it as it was installed is kept here, so whether it was changed cannot be told");
  });

  it("says nothing about a file of the old option that the project already deleted", () => {
    const { repository, project } = createWorldWithChoice();
    addToProject({ project, unit: "demo", repository });
    rmSync(join(project, A));

    const result = addToProject({ project, unit: "demo:bot-b", repository });

    expect(result.choiceRemoved).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it("does not write over a file the project already has where the new option's goes", () => {
    const { repository, project } = createWorldWithChoice();
    addToProject({ project, unit: "demo", repository });
    write(project, B, "// the project wrote this before it switched\n");

    const result = addToProject({ project, unit: "demo:bot-b", repository });

    expect(read(project, B)).toBe("// the project wrote this before it switched\n");
    expect(result.created).toEqual([]);
  });

  it("takes a project that had the add-on before it offered a choice as having the default, and keeps its file on an update", () => {
    const { repository, project } = createWorldBeforeTheChoice();

    const result = addToProject({ project, unit: "demo", repository });

    expect(result.choice).toBe("bot-a");
    expect(result.choiceRemoved).toEqual([]);
    expect(read(project, A)).toBe("# bot a, for @acme/web\n");
    expect(readJson(project, "tools/installed.json").demo.choice).toBe("bot-a");
  });

  it("moves such a project off the default it never chose by name, removing the file it never changed", () => {
    const { repository, project } = createWorldBeforeTheChoice();

    const result = addToProject({ project, unit: "demo:bot-b", repository });

    expect(result.choiceRemoved).toEqual([A]);
    expect(existsSync(join(project, A))).toBe(false);
    expect(existsSync(join(project, B))).toBe(true);
  });

  it("refuses an option the add-on does not have, names the ones it has, and changes nothing", () => {
    const { repository, project } = createWorldWithChoice();

    expect(() => addToProject({ project, unit: "demo:bot-c", repository })).toThrow(
      new InstallError('the add-on "demo" has no option "bot-c" — it has: bot-a, bot-b (bot-a when none is named)'),
    );
    expect(existsSync(join(project, "tools/demo/check.mts"))).toBe(false);
    expect(readJson(project, "package.json").scripts.demo).toBeUndefined();
  });

  it("refuses an option on an add-on that has no choice", () => {
    const { repository, project } = createWorldWithKit();

    expect(() => addToProject({ project, unit: "demo:bot-b", repository })).toThrow(/has no options, so "demo:bot-b" means nothing/);
    expect(existsSync(join(project, "tools/demo/check.mts"))).toBe(false);
  });

  it("goes back to the default when the option the project had is no longer offered", () => {
    const { repository, project } = createWorldWithChoice();
    addToProject({ project, unit: "demo:bot-b", repository });
    const manifest = readJson(repository, "addons/demo/addon.json");
    write(repository, "addons/demo/addon.json", JSON.stringify({ ...manifest, choice: { default: "bot-a", options: { "bot-a": "Bot A." } } }));

    expect(addToProject({ project, unit: "demo", repository }).choice).toBe("bot-a");
  });

  it("prints the option the project has with what the add-on says about it, and each file it removed", () => {
    const { repository, project } = createWorldWithChoice();
    addToProject({ project, unit: "demo", repository });

    const printed = describeResult(addToProject({ project, unit: "demo:bot-b", repository }), project);

    expect(printed).toContain("\n  option   bot-b: Bot B opens them.\n");
    expect(printed).toContain(`\n  removed  ${A} (an option this project no longer has; it was never changed here)\n`);
    expect(printed).toContain(`\n  created  ${B}\n`);
  });

  it("lists the options with the add-on, and which one is the default", () => {
    const { repository } = createWorldWithChoice();

    expect(listAddons(repository)[0]?.choice).toEqual({ default: "bot-a", options: { "bot-a": "Bot A opens them.", "bot-b": "Bot B opens them." } });
    expect(parseUnit("demo:bot-b")).toEqual({ name: "demo", option: "bot-b" });
    expect(parseUnit("demo")).toEqual({ name: "demo" });
  });
});

describe("a starting file that a later version of an add-on is the first to ship", () => {
  it("is written by the update, once, in a project that has no file there", () => {
    const { repository, project } = createWorldWithKit();
    withStartingFiles(repository);
    addToProject({ project, unit: "demo", repository });
    withPolicyFile(repository);

    const result = addToProject({ project, unit: "demo", repository });

    expect(result.created).toEqual(["POLICY.md"]);
    expect(read(project, "POLICY.md")).toBe("# Policy, as shipped\n");

    rmSync(join(project, "POLICY.md"));

    expect(addToProject({ project, unit: "demo", repository }).created).toEqual([]);
    expect(existsSync(join(project, "POLICY.md"))).toBe(false);
  });

  it("is not written over a file the project already has under that name", () => {
    const { repository, project } = createWorldWithKit();
    withStartingFiles(repository);
    addToProject({ project, unit: "demo", repository });
    write(project, "POLICY.md", "# The project's own policy\n");
    withPolicyFile(repository);

    expect(addToProject({ project, unit: "demo", repository }).created).toEqual([]);
    expect(read(project, "POLICY.md")).toBe("# The project's own policy\n");
  });

  it("is not written in a project whose copy of the add-on keeps no templates: a file missing there may have been deleted", () => {
    const { repository, project } = createWorldWithKit();
    addToProject({ project, unit: "demo", repository });
    withPolicyFile(repository);

    expect(addToProject({ project, unit: "demo", repository }).created).toEqual([]);
    expect(existsSync(join(project, "POLICY.md"))).toBe(false);
  });
});

/** Gives the demo add-on a text starting file it did not have before. */
function withPolicyFile(repository: string): void {
  const manifest = readJson(repository, "addons/demo/addon.json");

  write(repository, "addons/demo/addon.json", JSON.stringify({ ...manifest, startingFiles: [...(manifest.startingFiles ?? []), "POLICY.md"] }));
  write(repository, "addons/demo/files/POLICY.md", "# Policy, as shipped\n");
}

/** Gives the demo add-on a choice between two bots, each with one file, the first the default. */
function withChoice(repository: string): void {
  const manifest = readJson(repository, "addons/demo/addon.json");

  manifest.startingFiles = [];
  manifest.choice = { default: "bot-a", options: { "bot-a": "Bot A opens them.", "bot-b": "Bot B opens them." } };
  write(repository, "addons/demo/addon.json", JSON.stringify(manifest));
  write(repository, "addons/demo/choice/bot-a/files/.github/bot-a.yml", "# bot a, for @app/web\n");
  write(repository, "addons/demo/choice/bot-b/files/.github/bot-b.json5", "// bot b, for @app/web\n");
}

/** A project that took the demo add-on when bot A's file was a plain starting file, and the add-on as it is now, with the choice. */
function createWorldBeforeTheChoice(): { repository: string; project: string } {
  const world = createWorldWithKit();
  const { repository, project } = world;
  const manifest = readJson(repository, "addons/demo/addon.json");

  write(repository, "addons/demo/addon.json", JSON.stringify({ ...manifest, startingFiles: [".github/bot-a.yml"] }));
  write(repository, "addons/demo/files/.github/bot-a.yml", "# bot a, for @app/web\n");
  addToProject({ project, unit: "demo", repository });
  rmSync(join(repository, "addons/demo/files/.github/bot-a.yml"));
  withChoice(repository);

  return world;
}

function createWorldWithChoice(): { repository: string; project: string } {
  const world = createWorldWithKit();

  withChoice(world.repository);

  return world;
}

const KIT_FILES = [
  "tools/arch/gates/run.mts",
  "tools/arch/hooks/after-edit.mts",
  "tools/arch/hooks/claude.settings.json",
  "tools/arch/hooks/codex.hooks.json",
  "tools/arch/templates/architecture.config.mts.txt",
];

const CLAUDE_SETTINGS = '{ "hooks": "node tools/arch/hooks/after-edit.mts" }\n';

/** Gives the stand-in repository a starter with an AGENTS.md, as the real one has. */
function withStarterInstructions(repository: string, text: string): void {
  write(repository, "starter/AGENTS.md", text);
}

/** Gives the demo add-on two starting files: one named exactly, one by its folder. */
function withStartingFiles(repository: string): void {
  const manifest = readJson(repository, "addons/demo/addon.json");

  manifest.startingFiles = ["packages/web/tests/scenarios.ts", "packages/web/tests/goldens/"];
  write(repository, "addons/demo/addon.json", JSON.stringify(manifest));
  write(repository, "addons/demo/files/packages/web/tests/scenarios.ts", "// scenarios, as shipped\n");
  write(repository, "addons/demo/files/packages/web/tests/goldens/a.png", "an image, as shipped");
}

/** Gives the demo add-on a permission rule and a hook to merge into Claude Code's settings. */
function withHostSettings(repository: string): void {
  const manifest = readJson(repository, "addons/demo/addon.json");

  manifest.hostSettings = {
    ".claude/settings.json": {
      permissions: { allow: ["Bash(gh pr create *)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node tools/demo/hook.mts" }] }] },
    },
  };
  write(repository, "addons/demo/addon.json", JSON.stringify(manifest));
}

/** A settings file a project has made its own: a rule, a refusal, a hook and a key no add-on knows. */
function createProjectSettings(): unknown {
  return {
    model: "opus",
    permissions: { allow: ["Bash(make *)"], deny: ["Bash(rm -rf *)"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "node tools/arch/hooks/before-stop.mts" }] }] },
  };
}

function createWorldWithKit(): { repository: string; project: string } {
  const world = createWorld();

  addToProject({ project: world.project, unit: "kit", repository: world.repository });

  return world;
}

/** A small stand-in for this repository, and a project with two packages. */
function createWorld(): { repository: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), "add-to-project-"));

  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const repository = join(root, "repository");
  const project = join(root, "project");

  write(repository, "kit/gates/run.mts", "// gates, version 1\n");
  write(repository, "kit/gates/run.test.mts", "// the kit's own test\n");
  write(repository, "kit/hooks/after-edit.mts", "// hook, version 1\n");
  write(repository, "kit/hooks/claude.settings.json", '{ "hooks": "node tools/arch/hooks/after-edit.mts" }\n');
  write(repository, "kit/hooks/codex.hooks.json", '{ "hooks": "node tools/arch/hooks/after-edit.mts" }\n');
  write(repository, "kit/architecture.config.example.mts", "// the example config\n");
  write(
    repository,
    "addons/demo/addon.json",
    JSON.stringify({
      name: "demo",
      summary: "A demo add-on.",
      packageJson: {
        ".": { scripts: { demo: "node tools/demo/check.mts" }, devDependencies: { "demo-tool": "^1.0.0" } },
        "packages/*": { scripts: { "test:demo": "demo --filter @app/web" } },
      },
      gates: { fast: ["pnpm demo"], full: ["pnpm demo:slow"] },
      verify: "pnpm --filter @app/web demo",
    }),
  );
  write(repository, "addons/demo/files/tools/demo/check.mts", "// the add-on's check\n");
  write(repository, "addons/demo/files/packages/web/tests/demo.ts", 'import { thing } from "@app/web";\n');
  write(repository, "addons/demo/AGENTS.section.md", "## Demo\n\nThe first wording.\n");
  write(repository, "addons/demo/tests/check.test.mts", "// never copied: it is outside files/\n");

  write(
    project,
    "package.json",
    `${JSON.stringify(
      {
        name: "project",
        scripts: {
          "check:react-policies": "node tools/arch/check-react-policies.mts",
          "check:compiler": "node tools/arch/check-compiler.mts",
          "gate:fast": "pnpm gates && pnpm lint",
          "gate:full": "pnpm gate:fast && pnpm test",
        },
      },
      null,
      2,
    )}\n`,
  );
  write(project, "packages/web/package.json", '{ "name": "@acme/web", "scripts": {} }\n');
  write(project, "packages/api/package.json", '{ "name": "@acme/api" }\n');
  write(project, "AGENTS.md", "# Working here\n\nThe project's own text.\n");

  return { repository, project };
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

/** Loosely typed on purpose: each test asserts the shape of the file it reads. */
function readJson(root: string, path: string): any {
  return JSON.parse(read(root, path));
}
