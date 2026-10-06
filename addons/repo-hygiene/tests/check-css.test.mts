import { chmodSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkCss, formatResult } from "../files/tools/repo-hygiene/check-css.mts";
import { CouldNotRun } from "../files/tools/repo-hygiene/lib/run.mts";
import { createFakeTools, createFolder, initGit } from "./support.mts";

const CONFIG = { "tools/repo-hygiene/stylelint.json": '{ "extends": ["./stylelint.base.json"] }', "tools/repo-hygiene/stylelint.base.json": "{}" };

describe("a project with stylesheets", () => {
  it("gives stylelint the rules file and every stylesheet, and says how many it linted", () => {
    const tools = createFakeTools();
    const result = checkCss(createFolder({ ...CONFIG, "packages/a/src/ui.css": "", "packages/a/src/base.css": "" }), tools.run);

    expect(tools.calls).toEqual(["stylelint --config tools/repo-hygiene/stylelint.json --max-warnings 0 packages/a/src/base.css packages/a/src/ui.css"]);
    expect(result.failed).toBe(false);
    expect(formatResult(result)).toBe("PASS css — 2 stylesheet(s) linted");
  });

  it("fails with stylelint's report when stylelint finds a problem", () => {
    const tools = createFakeTools({ stylelint: { status: 2, stderr: "\nsrc/ui.css\n  1:5  ✖  Unknown property \"colr\"  property-no-unknown\n" } });
    const result = checkCss(createFolder({ ...CONFIG, "src/ui.css": "" }), tools.run);

    expect(result.failed).toBe(true);
    expect(formatResult(result)).toBe(
      [
        "FAIL css",
        "",
        'src/ui.css\n  1:5  ✖  Unknown property "colr"  property-no-unknown',
        "",
        "Fix the stylesheet. A rule this project does not want is turned off in tools/repo-hygiene/stylelint.json.",
      ].join("\n"),
    );
  });

  it("could not run, and has not failed, when stylelint rejects its configuration", () => {
    const tools = createFakeTools({ stylelint: { status: 78, stderr: "\nConfigurationError: Could not find \"x\".\n    at getModulePath\n" } });

    expect(() => checkCss(createFolder({ ...CONFIG, "src/ui.css": "" }), tools.run)).toThrow(
      new CouldNotRun('stylelint stopped with exit 78: ConfigurationError: Could not find "x".'),
    );
  });

  it("could not run when the rules file is gone", () => {
    expect(() => checkCss(createFolder({ "src/ui.css": "" }), createFakeTools().run)).toThrow(/tools\/repo-hygiene\/stylelint\.json is missing/);
  });

  it("lints a large project in runs of 200 files, and fails if any run does", () => {
    const files = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`src/s${String(index).padStart(3, "0")}.css`, ""]));
    const tools = createFakeTools({ "stylelint --config tools/repo-hygiene/stylelint.json --max-warnings 0 src/s200.css": { status: 2, stdout: "src/s200.css: bad" } });
    const result = checkCss(createFolder({ ...CONFIG, ...files }), tools.run);

    expect(tools.calls.map((call) => call.split(" ").length - 5)).toEqual([200, 1]);
    expect(result).toMatchObject({ failed: true, report: "src/s200.css: bad", files: 201 });
  });
});

describe("which stylesheets are linted", () => {
  it("leaves out built, installed and tooling folders", () => {
    const tools = createFakeTools();

    checkCss(
      createFolder({ ...CONFIG, "src/ui.css": "", "dist/assets/ui.css": "", "node_modules/x/x.css": "", "tools/perf/report.css": "" }),
      tools.run,
    );

    expect(tools.calls).toEqual(["stylelint --config tools/repo-hygiene/stylelint.json --max-warnings 0 src/ui.css"]);
  });

  it("leaves out a stylesheet git ignores", () => {
    const root = createFolder({ ...CONFIG, ".gitignore": "generated/\n", "src/ui.css": "", "generated/theme.css": "" });
    const tools = createFakeTools();

    initGit(root);
    checkCss(root, tools.run);

    expect(tools.calls).toEqual(["stylelint --config tools/repo-hygiene/stylelint.json --max-warnings 0 src/ui.css"]);
  });
});

describe("a project with no stylesheet", () => {
  it("is skipped without running stylelint, and never passes", () => {
    const tools = createFakeTools();
    const result = checkCss(createFolder({ "src/main.ts": "" }), tools.run);

    expect(tools.calls).toEqual([]);
    expect(result.skipped).toBe("no .css file in the project");
    expect(formatResult(result)).toBe("SKIP css — no .css file in the project");
  });
});

describe("running an installed tool", () => {
  it("could not run when the tool is not installed, and says to install", () => {
    const root = createFolder({ ...CONFIG, "src/ui.css": "" });

    expect(() => checkCss(root)).toThrow(new CouldNotRun("stylelint is not installed (there is no node_modules/.bin/stylelint). Run `pnpm install`."));
  });

  it("runs the project's own copy, in the project, and passes on what it printed", () => {
    const root = createFolder({
      ...CONFIG,
      "src/ui.css": "",
      "node_modules/.bin/stylelint": '#!/bin/sh\necho "ran in $(basename "$PWD") with $1, colour $NO_COLOR"\nexit 2\n',
    });

    chmodSync(join(root, "node_modules/.bin/stylelint"), 0o755);

    expect(checkCss(root).report).toBe(`ran in ${basename(root)} with --config, colour 1`);
  });
});

describe("a rules file that does not carry the add-on's rules", () => {
  const BASE = { "tools/repo-hygiene/stylelint.base.json": "{}" };
  const check = (config: string): ReturnType<typeof checkCss> => checkCss(createFolder({ ...BASE, "tools/repo-hygiene/stylelint.json": config, "src/ui.css": "" }), createFakeTools().run);

  it("fails though stylelint found nothing, and says what the file extends and what to put there", () => {
    // What the add-on shipped before it had a base: every rule added since is off in such a file.
    const result = check('{ "extends": ["stylelint-config-standard"] }');

    expect(result.failed).toBe(true);
    expect(formatResult(result).split("\n")).toEqual([
      "FAIL css",
      "",
      'tools/repo-hygiene/stylelint.json does not extend ./stylelint.base.json, so none of the add-on\'s rules is on: it extends "stylelint-config-standard". Put "./stylelint.base.json" in its "extends" (the base brings the preset with it), and keep below it the rules this project changes. The file as the add-on ships it now is tools/templates/repo-hygiene.tools__repo-hygiene__stylelint.json.txt.',
    ]);
  });

  it.each([
    ["no extends", "{}", "it extends nothing"],
    ["an empty list", '{ "extends": [] }', "it extends nothing"],
    ["the preset alone, as one name", '{ "extends": "stylelint-config-standard" }', 'it extends "stylelint-config-standard"'],
    ["another file, and a package called like the base", '{ "extends": ["./other.json", "stylelint.base.json"] }', 'it extends "./other.json", "stylelint.base.json"'],
    ["a file called like the base in another folder", '{ "extends": ["../stylelint.base.json"] }', 'it extends "../stylelint.base.json"'],
  ])("fails for %s", (_what, config, says) => {
    expect(check(config).missingBase).toContain(says);
  });

  it.each([
    ["the base in a list", '{ "extends": ["./stylelint.base.json"] }'],
    ["the base as one name", '{ "extends": "./stylelint.base.json" }'],
    ["the base after another, with rules of the project's own", '{ "extends": ["stylelint-config-x", "./stylelint.base.json"], "rules": { "color-named": null } }'],
    ["the base by another path to the same file", '{ "extends": ["../repo-hygiene/stylelint.base.json"] }'],
  ])(
    "passes for %s",
    (_what, config) => {
      const result = check(config);

      expect(result.missingBase).toBeUndefined();
      expect(formatResult(result)).toBe("PASS css — 1 stylesheet(s) linted");
    },
  );

  it("is said together with what stylelint found, not in place of it", () => {
    const tools = createFakeTools({ stylelint: { status: 2, stderr: "src/ui.css\n  1:5  ✖  Unknown property\n" } });
    const printed = formatResult(checkCss(createFolder({ ...BASE, "tools/repo-hygiene/stylelint.json": "{}", "src/ui.css": "" }), tools.run));

    expect(printed).toContain("does not extend ./stylelint.base.json");
    expect(printed).toContain("Unknown property");
    expect(printed).toContain("Fix the stylesheet.");
  });

  it("could not run when the rules file is not JSON, or the base is gone: neither is a verdict", () => {
    expect(() => check("{ bad")).toThrow(/tools\/repo-hygiene\/stylelint\.json is not JSON: /);
    expect(() => checkCss(createFolder({ "tools/repo-hygiene/stylelint.json": "{}", "src/ui.css": "" }), createFakeTools().run)).toThrow(
      new CouldNotRun("tools/repo-hygiene/stylelint.base.json is missing. It holds the add-on's rules; add the add-on again to get it back."),
    );
  });

  it("is not asked of a project with no stylesheet: there is nothing the rules would judge", () => {
    expect(formatResult(checkCss(createFolder({ "tools/repo-hygiene/stylelint.json": "{}" }), createFakeTools().run))).toBe("SKIP css — no .css file in the project");
  });

  it("holds for the file the add-on ships", () => {
    const shipped = readFileSync(join(import.meta.dirname, "../files/tools/repo-hygiene/stylelint.json"), "utf8");

    expect(check(shipped).missingBase).toBeUndefined();
  });
});
