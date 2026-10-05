import { describe, expect, it } from "vitest";

import { checkTypes, formatResult } from "../files/tools/strict-lint/check-types.mts";
import { CouldNotRun } from "../files/tools/strict-lint/lib/run.mts";
import { createFakeTools, createFolder } from "./support.mts";

const CONFIG = { "tools/strict-lint/eslint.config.mts": "" };
const SOURCE = { ...CONFIG, "packages/a/src/a.ts": "" };

describe("a project with TypeScript files", () => {
  it("gives ESLint the project's config, the flag that loads a .mts config, and no room for a warning", () => {
    const tools = createFakeTools({ stdout: createReport([]) });

    checkTypes(createFolder(SOURCE), tools.run);

    expect(tools.calls).toEqual([
      "eslint --flag unstable_native_nodejs_ts_config --config tools/strict-lint/eslint.config.mts --max-warnings 0 --format json .",
    ]);
  });

  it("passes, and says how many files ESLint judged", () => {
    const root = createFolder(SOURCE);
    const tools = createFakeTools({ stdout: createReport([createFileResult(root, "packages/a/src/a.ts"), createFileResult(root, "packages/a/src/b.ts")]) });
    const result = checkTypes(root, tools.run);

    expect(result.findings).toEqual([]);
    expect(formatResult(result)).toBe("PASS lint:types — 2 file(s) linted with type information");
  });

  it("fails with the file, the place, the rule and the message of each finding, and what to do", () => {
    const root = createFolder(SOURCE);
    const finding = { ruleId: "@typescript-eslint/no-floating-promises", line: 7, column: 3, message: "Promises must be awaited." };
    const tools = createFakeTools({ status: 1, stdout: createReport([createFileResult(root, "packages/a/src/a.ts", [finding])]) });

    expect(formatResult(checkTypes(root, tools.run))).toBe(
      [
        "FAIL lint:types — 1 finding(s)",
        "",
        "packages/a/src/a.ts:7:3  @typescript-eslint/no-floating-promises  Promises must be awaited.",
        "",
        "A promise nothing waits for: await it, return it, or mark it `void` with a comment that says why nothing waits.",
      ].join("\n"),
    );
  });

  it("says in plain words that no tsconfig.json includes a file, and what to do about it", () => {
    const root = createFolder(SOURCE);
    const message = `Parsing error: ${root}/packages/a/vitest.config.ts was not found by the project service. Consider either including it in the tsconfig.json or including it in allowDefaultProject.`;
    const tools = createFakeTools({ status: 1, stdout: createReport([createFileResult(root, "packages/a/vitest.config.ts", [{ ruleId: null, message }])]) });
    const report = formatResult(checkTypes(root, tools.run));

    expect(report).toContain("packages/a/vitest.config.ts:0:0  parse  no tsconfig.json includes this file");
    expect(report.split("\n").at(-1)).toBe(
      "A file no tsconfig.json includes is not typechecked either: add it to the `include` of the tsconfig.json of its package.",
    );
  });

  it("gives the advice for each rule that fired, once, and none for a rule of the project's own", () => {
    const root = createFolder(SOURCE);
    const tools = createFakeTools({
      status: 1,
      stdout: createReport([
        createFileResult(root, "packages/a/src/a.ts", [
          { ruleId: "@typescript-eslint/switch-exhaustiveness-check", line: 1, column: 1, message: "Switch is not exhaustive." },
          { ruleId: "@typescript-eslint/switch-exhaustiveness-check", line: 9, column: 1, message: "Switch is not exhaustive." },
          { ruleId: "@typescript-eslint/no-misused-promises", line: 5, column: 1, message: "Promise returned." },
          { ruleId: "no-debugger", line: 6, column: 1, message: "Unexpected 'debugger' statement." },
        ]),
      ]),
    });

    expect(formatResult(checkTypes(root, tools.run)).split("\n").slice(-3)).toEqual([
      "",
      "A promise where none is expected: do not make the callback `async`; use a `for…of` loop with `await`, or handle the promise where it is made.",
      "A switch that misses a case: add the case, or a `default` branch if the rest are handled alike.",
    ]);
  });

  it("ends with the findings when no rule that fired has advice", () => {
    const root = createFolder(SOURCE);
    const finding = { ruleId: "no-debugger", line: 6, column: 1, message: "Unexpected 'debugger' statement." };
    const tools = createFakeTools({ status: 1, stdout: createReport([createFileResult(root, "packages/a/src/a.ts", [finding])]) });

    expect(formatResult(checkTypes(root, tools.run))).toBe(
      "FAIL lint:types — 1 finding(s)\n\npackages/a/src/a.ts:6:1  no-debugger  Unexpected 'debugger' statement.",
    );
  });

  it("keeps the words of any other parsing error", () => {
    const root = createFolder(SOURCE);
    const tools = createFakeTools({
      status: 1,
      stdout: createReport([createFileResult(root, "packages/a/src/a.ts", [{ ruleId: null, line: 2, column: 5, message: "Parsing error: ';' expected." }])]),
    });

    expect(formatResult(checkTypes(root, tools.run))).toContain("packages/a/src/a.ts:2:5  parse  Parsing error: ';' expected.");
  });
});

describe("a project with nothing to judge", () => {
  it("is skipped without running ESLint when it has no TypeScript file, and never passes", () => {
    const tools = createFakeTools();
    const result = checkTypes(createFolder({ ...CONFIG, "README.md": "" }), tools.run);

    expect(tools.calls).toEqual([]);
    expect(formatResult(result)).toBe("SKIP lint:types — no TypeScript file in the project outside tools/");
  });

  it("is skipped when ESLint ran and judged no file", () => {
    const result = checkTypes(createFolder(SOURCE), createFakeTools({ stdout: createReport([]) }).run);

    expect(formatResult(result)).toBe("SKIP lint:types — ESLint judged no file: the config ignores every TypeScript file");
  });
});

describe("a run with no verdict", () => {
  it("could not run when ESLint stops with exit 2, and gives its first line", () => {
    const tools = createFakeTools({ status: 2, stderr: "\nOops! Something went wrong! :(\n\nESLint: 10.12.0\n" });

    expect(() => checkTypes(createFolder(SOURCE), tools.run)).toThrow(new CouldNotRun("eslint stopped with exit 2: Oops! Something went wrong! :("));
  });

  it("could not run when the project's config is gone", () => {
    expect(() => checkTypes(createFolder({ "packages/a/src/a.ts": "" }), createFakeTools().run)).toThrow(
      /tools\/strict-lint\/eslint\.config\.mts is missing/,
    );
  });

  it("could not run when ESLint fails and names no finding", () => {
    const tools = createFakeTools({ status: 1, stdout: createReport([]), stderr: "ESLint found too many warnings (maximum: 0).\n" });

    expect(() => checkTypes(createFolder(SOURCE), tools.run)).toThrow(
      new CouldNotRun("eslint failed and named no finding: ESLint found too many warnings (maximum: 0)."),
    );
  });

  it("could not run when ESLint prints something that is not its report", () => {
    const tools = createFakeTools({ stdout: "Warning: something\n" });

    expect(() => checkTypes(createFolder(SOURCE), tools.run)).toThrow(new CouldNotRun("eslint did not print its JSON report: Warning: something"));
  });
});

interface ReportedMessage {
  ruleId: string | null;
  line?: number;
  column?: number;
  message: string;
}

interface ReportedFile {
  filePath: string;
  messages: ReportedMessage[];
}

/** One entry of ESLint's JSON report: a file under `root` and what was found in it. */
function createFileResult(root: string, path: string, messages: ReportedMessage[] = []): ReportedFile {
  return { filePath: `${root}/${path}`, messages };
}

function createReport(files: ReportedFile[]): string {
  return JSON.stringify(files);
}
