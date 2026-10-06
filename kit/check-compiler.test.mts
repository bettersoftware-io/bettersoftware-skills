import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { type CompilerEvent, isInsideCacheCheck, judgeTracked, whyNotMemoized } from "./check-compiler.mts";

const SCRIPT = join(import.meta.dirname, "check-compiler.mts");
const fixtures = join(import.meta.dirname, "gates", "fixtures");
const FILE = "packages/client-react/src/ui/Chart.tsx";

describe("a client whose tracked functions the compiler memoizes", () => {
  it("passes, with one line for each function and each value it judged", () => {
    const run = runIn(join(fixtures, "react-clean"));

    expect(run.stdout.split("\n")).toEqual([
      "ok  packages/client-react/src/ui/App.tsx  App  (1 memoized value(s), at least 1 asked)",
      "ok  packages/client-react/src/ui/Totals.tsx  Totals  total  (memoized)",
      "ok  packages/client-react/src/ui/Totals.tsx  Totals  pickFirst  (memoized)",
      "ok  packages/client-react/src/ui/Totals.tsx  Totals  (3 memoized value(s), at least 3 asked)",
      "ok  packages/client-react/src/ui/Shared.tsx  Shared  visible  (memoized)",
      "",
      "PASS compiler — 5 tracked value(s) and function(s) are memoized",
      "",
    ]);
    expect(run.status).toBe(0);
  });
});

describe("a client whose tracked functions the compiler does not memoize", () => {
  let output = "";
  let status: number | null = null;

  const about = (file: string): string => output.split(/\n {2}(?=\S)/).filter((finding) => finding.startsWith(`packages/client-loose/src/ui/${file}:`)).join("\n");

  // Judged once, before any case, so that one case can be run alone.
  beforeAll(() => {
    const run = runIn(join(fixtures, "react-broken"));

    output = run.stdout;
    status = run.status;
  });

  it("fails", () => {
    expect(status).toBe(1);
    expect(output).toContain("FAIL compiler (5)");
    expect(output).not.toContain("ok  ");
  });

  it("names a value that is worked out on every render inside a function that compiles, and one that is gone", () => {
    expect(about("Inline.tsx")).toContain("Inline compiles, and these values in it are not memoized:");
    expect(about("Inline.tsx")).toContain("label is computed on every render (`count * 2`)");
    expect(about("Inline.tsx")).toContain("gone is not in the compiled code");
  });

  it("names a function the compiler skipped, with the line and the reason it gave, once", () => {
    expect(about("Bails.tsx")).toContain("Bails is not compiled, so nothing in it is memoized.");
    expect(about("Bails.tsx").match(/line 9: Cannot access refs during render/g)).toHaveLength(1);
  });

  it("names a tracked function that is no longer there, and a tracked file that is not", () => {
    expect(about("Renamed.tsx")).toContain("compiled no function called OldName, and gave up on none");
    expect(about("Moved.tsx")).toContain("the file does not exist, so nothing holds the compiler to Moved");
  });

  it("names a function that memoizes fewer values than asked, and leaves the entry that asks for one alone", () => {
    expect(about("App.tsx")).toContain("App compiles and memoizes 1 value(s), below the 4 asked");
    expect(about("App.tsx").match(/App compiles/g)).toHaveLength(1);
  });

  it("judges only the clients that declare the compiler", () => {
    expect(output).not.toContain("packages/client-quiet");
    expect(output).not.toContain("packages/client-unlinted");
  });
});

describe("what the compiled code says about one value", () => {
  it("is memoized when it is declared as a bare temporary", () => {
    expect(whyNotMemoized("let t1;\nif ($[0] !== rows) {\n  t1 = rows.length;\n  $[0] = rows;\n  $[1] = t1;\n} else {\n  t1 = $[1];\n}\nconst total = t1;\n", "total")).toBeUndefined();
    expect(whyNotMemoized("const total = t12;\n", "total")).toBeUndefined();
  });

  it("is not when it keeps its expression at the top of the function, even one that starts like a temporary", () => {
    expect(whyNotMemoized("const total = rows.length;\n", "total")).toContain("total is computed on every render (`rows.length`)");
    expect(whyNotMemoized("const total = t1.length;\n", "total")).toContain("computed on every render");
    expect(whyNotMemoized("const total = tally;\n", "total")).toContain("computed on every render");
  });

  it("is memoized when it is declared inside the branch of a cache check, at any depth", () => {
    const merged = createMergedBlock();

    expect(whyNotMemoized(merged, "visible")).toBeUndefined();
    expect(whyNotMemoized(merged, "nested")).toBeUndefined();
    expect(whyNotMemoized(merged, "after")).toContain("after is computed on every render");
  });

  it("is memoized when it is declared bare and read back from the slot it was written to", () => {
    const fused = "let rows;\nif ($[0] !== log) {\n  rows = log.filter(_temp);\n  filter = { ...a, size: rows.length };\n  $[0] = log;\n  $[1] = rows;\n  $[2] = filter;\n} else {\n  rows = $[1];\n  filter = $[2];\n}\n";

    expect(whyNotMemoized(fused, "rows")).toBeUndefined();
    expect(whyNotMemoized(fused.replace("rows = $[1];", "rows = $[2];"), "rows")).toContain("rows is not in the compiled code");
    expect(whyNotMemoized("let rows;\nrows = log.filter(_temp);\n", "rows")).toContain("rows is not in the compiled code");
  });

  it("refuses to guess about a value that became a function declaration", () => {
    expect(whyNotMemoized("function pick(row) {\n  return row;\n}\n", "pick")).toContain("a shape this check cannot classify");
  });

  it("does not count a brace in a comment or a string as a block", () => {
    const code = '// if ($[0] !== a) {\nconst text = "if ($[1] !== b) {";\nconst late = a + b;\n';

    expect(isInsideCacheCheck(code, code.indexOf("const late"))).toBe(false);
    expect(isInsideCacheCheck("if (ready) {\n  const late = a;\n}\n", 16)).toBe(false);
    expect(isInsideCacheCheck('if ($[0] === Symbol.for("react.memo_cache_sentinel")) {\n  const late = a;\n}\n', 60)).toBe(true);
    expect(isInsideCacheCheck("if ($[0] !== a) {\n  t1 = a;\n}\nconst late = a;\n", 30)).toBe(false);
  });
});

describe("what the compiler's events say about one function", () => {
  const success = (fnName: string, memoValues: number): CompilerEvent => ({ kind: "CompileSuccess", fnName, memoValues });

  it("takes the count of the tracked function, never of another one in the file", () => {
    const events = [success("Legend", 6), success("Chart", 0)];

    expect(judgeTracked(FILE, { file: "", fn: "Chart" }, { code: "", events }).findings).toEqual([
      expect.stringContaining("Chart compiles and memoizes 0 value(s), below the 1 asked"),
    ]);
    expect(judgeTracked(FILE, { file: "", fn: "Legend", minMemoValues: 6 }, { code: "", events }).passed).toEqual([
      `${FILE}  Legend  (6 memoized value(s), at least 6 asked)`,
    ]);
  });

  it("lists what the compiler gave up on, since such an event names no function", () => {
    const events: CompilerEvent[] = [
      { kind: "CompileSkip", detail: { description: "Skipped by a directive\nmore" }, fnLoc: { start: { line: 4 } } },
      { kind: "CompileError", detail: {}, fnLoc: null },
      { kind: "CompileDiagnostic", detail: { reason: "not a failure" } },
    ];
    const [finding = ""] = judgeTracked(FILE, { file: "", fn: "Chart" }, { code: "", events }).findings;

    expect(finding).toContain("Chart is not compiled");
    expect(finding).toContain("line 4: Skipped by a directive\n");
    expect(finding).toContain("line ?: no reason given");
    expect(finding).not.toContain("not a failure");
  });

  it("says so when the compiler produced no code", () => {
    expect(judgeTracked(FILE, { file: "", fn: "Chart" }, { code: undefined, events: [success("Chart", 3)] }).findings).toEqual([
      `${FILE}: the compiler returned no output, so nothing can be said about Chart.`,
    ]);
  });
});

describe("a project it cannot judge", () => {
  it("reports a skip when no client declares the compiler", () => {
    const run = runIn(join(fixtures, "clean"));

    expect(run.stdout).toBe("SKIP compiler — no client declares reactCompiler: true, so there was nothing to check\n");
    expect(run.status).toBe(0);
  });

  it("reports a skip, never a pass, when a client relies on the compiler and tracks nothing", () => {
    const run = runIn(createProject({ tracked: [] }));

    expect(run.stdout).toBe(
      "SKIP compiler — packages/client-react relies on the compiler and lists no function under compilerTracked, so nothing was held to it\n",
    );
    expect(run.status).toBe(0);
  });

  it("exits 2 when the compiler is not installed in the client, and says what to add", () => {
    // In a folder outside this repository, nothing above the client has Babel.
    const run = runIn(createProject({ tracked: [{ file: "src/ui/App.tsx", fn: "App" }] }));

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("compiler check could not run: packages/client-react declares reactCompiler: true, and @babel/core or babel-plugin-react-compiler cannot be loaded from it");
    expect(run.stdout).toBe("");
  });

  it("exits 2 where no layers are declared", () => {
    const run = runIn(fixtures);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("compiler check could not run");
  });
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the script the way a project does: in the project's root. */
function runIn(root: string): Run {
  const { status, stdout, stderr } = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });

  return { status, stdout, stderr };
}

interface ProjectOptions {
  tracked: object[];
}

/** A project in the system's temporary folder, with one client that declares the compiler and installs nothing. */
function createProject({ tracked }: ProjectOptions): string {
  const root = mkdtempSync(join(tmpdir(), "arch-compiler-"));
  const files: Record<string, string> = {
    "architecture.config.mts": `export default ${JSON.stringify({
      packages: { "packages/client-react": { role: "client", reactCompiler: true, compilerTracked: tracked } },
    })};\n`,
    "packages/client-react/package.json": JSON.stringify({ name: "@fx/client-react", type: "module" }),
    "packages/client-react/src/ui/App.tsx": "export function App() {\n  return <main />;\n}\n",
  };

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }

  return root;
}

/** Compiled code in which `visible` and `nested` sit inside a cache check's branch, and `after` does not. */
function createMergedBlock(): string {
  return [
    "export function Shared(t0) {",
    "  const $ = _c(11);",
    "  const { rows, limit } = t0;",
    "  let t1;",
    "  if ($[0] !== limit || $[1] !== rows) {",
    "    let t4;",
    "    if ($[5] !== limit) {",
    "      t4 = row => row < limit;",
    "      const nested = limit + 1;",
    "      $[5] = limit;",
    "    } else {",
    "      t4 = $[6];",
    "    }",
    "    const visible = rows.filter(t4);",
    "    t1 = visible.length;",
    "    $[0] = limit;",
    "  } else {",
    "    t1 = $[2];",
    "  }",
    "  const after = rows.length + 1;",
    "  return t1 + after;",
    "}",
    "",
  ].join("\n");
}
