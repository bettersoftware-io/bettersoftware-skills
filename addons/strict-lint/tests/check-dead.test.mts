import { describe, expect, it } from "vitest";

import { checkDead, formatResult } from "../files/tools/strict-lint/check-dead.mts";
import { CouldNotRun } from "../files/tools/strict-lint/lib/run.mts";
import { createFakeTools, createFolder } from "./support.mts";

const CONFIG = { "tools/strict-lint/knip.jsonc": "{}" };
const SOURCE = { ...CONFIG, "packages/a/src/a.ts": "", "packages/a/src/b.tsx": "" };

describe("a project with TypeScript files", () => {
  it("gives knip the project's config and asks for a plain report", () => {
    const tools = createFakeTools();

    checkDead(createFolder(SOURCE), tools.run);

    expect(tools.calls).toEqual(["knip --config tools/strict-lint/knip.jsonc --no-progress --no-config-hints"]);
  });

  it("passes when knip finds nothing, and says how many files the project has", () => {
    const result = checkDead(createFolder(SOURCE), createFakeTools().run);

    expect(result.failed).toBe(false);
    expect(formatResult(result)).toBe("PASS lint:dead — knip found nothing unused (2 TypeScript file(s) in the project)");
  });

  it("fails with knip's own report, and what to do", () => {
    const tools = createFakeTools({ status: 1, stdout: "Unused files (1)\npackages/a/src/b.tsx\n" });

    expect(formatResult(checkDead(createFolder(SOURCE), tools.run))).toBe(
      [
        "FAIL lint:dead",
        "",
        "Unused files (1)\npackages/a/src/b.tsx",
        "",
        "Remove what is unused: the file, the `export` keyword, the line in package.json.",
        "If it is used in a way knip cannot see, name that file as an entry in tools/strict-lint/knip.jsonc.",
      ].join("\n"),
    );
  });
});

describe("a project with nothing to judge", () => {
  it("is skipped without running knip, and never passes", () => {
    const tools = createFakeTools();
    const result = checkDead(createFolder({ ...CONFIG, "tools/arch/run.mts": "" }), tools.run);

    expect(tools.calls).toEqual([]);
    expect(formatResult(result)).toBe("SKIP lint:dead — no TypeScript file in the project outside tools/");
  });
});

describe("a run with no verdict", () => {
  it("could not run when knip stops with exit 2, and gives its first line", () => {
    const tools = createFakeTools({ status: 2, stderr: "ERROR: Unable to parse tools/strict-lint/knip.jsonc\n" });

    expect(() => checkDead(createFolder(SOURCE), tools.run)).toThrow(
      new CouldNotRun("knip stopped with exit 2: ERROR: Unable to parse tools/strict-lint/knip.jsonc"),
    );
  });

  it("could not run when the project's config is gone", () => {
    expect(() => checkDead(createFolder({ "packages/a/src/a.ts": "" }), createFakeTools().run)).toThrow(/tools\/strict-lint\/knip\.jsonc is missing/);
  });

  it("could not run when knip fails and names no finding", () => {
    const tools = createFakeTools({ status: 1, stderr: "something else\n" });

    expect(() => checkDead(createFolder(SOURCE), tools.run)).toThrow(new CouldNotRun("knip failed and named no finding: something else"));
  });
});
