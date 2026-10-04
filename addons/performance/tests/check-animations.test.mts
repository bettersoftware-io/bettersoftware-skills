import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import shippedAllowList from "../files/tools/perf/allowed.mts";
import { type CheckResult, checkAnimations, formatResult } from "../files/tools/perf/check-animations.mts";
import { AllowedError, checkAllowed } from "../files/tools/perf/lib/allowed.mts";
import { scanCss } from "../files/tools/perf/lib/css.mts";
import type { Finding } from "../files/tools/perf/lib/rules.mts";
import { scanAnimateCalls } from "../files/tools/perf/lib/waapi.mts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const script = join(here, "..", "files", "tools", "perf", "check-animations.mts");

describe("a project whose animations are compositor-only", () => {
  let result: CheckResult;

  beforeAll(async () => {
    result = await checkAnimations({ root: join(fixtures, "clean") });
  });

  it("has no findings and nothing left unjudged", () => {
    expect(result.findings).toEqual([]);
    expect(result.unjudged).toEqual([]);
  });

  it("says how much it judged, so the pass is not empty", () => {
    expect(result.skipped).toBeUndefined();
    expect(result.tally).toEqual({ transitions: 2, keyframes: 3, animateCalls: 1 });
    expect(formatResult(result)).toBe(
      "PASS animations — judged 2 transition(s), 3 @keyframes and 1 .animate( call(s) in 1 stylesheet(s) and 1 TypeScript file(s)",
    );
  });
});

describe("a project that breaks the rules", () => {
  let findings: Finding[] = [];
  let result: CheckResult;

  const at = (file: string, line: number): Finding[] =>
    findings.filter((finding) => finding.file === file && finding.line === line);

  beforeAll(async () => {
    result = await checkAnimations({ root: join(fixtures, "broken") });
    findings = result.findings;
  });

  it("fails a @keyframes that animates a paint property, once, on its first line", () => {
    const [finding, ...rest] = at("src/keyframes.css", 7);

    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ rule: "@keyframes flash", property: "background-color" });
    expect(finding?.message).toContain("a paint property");
    expect(finding?.message).toContain("animate the overlay's `opacity`");
    expect(at("src/keyframes.css", 11)).toEqual([]);
  });

  it("fails a @keyframes that animates a layout property, and leaves its opacity alone", () => {
    expect(at("src/keyframes.css", 17)).toMatchObject([{ rule: "@keyframes grow", property: "width" }]);
    expect(at("src/keyframes.css", 17)[0]?.message).toContain("a layout property");
    expect(at("src/keyframes.css", 18)).toEqual([]);
  });

  it("fails var() inside a transform in a keyframe, and leaves the literal keyframe alone", () => {
    expect(at("src/keyframes.css", 24)).toMatchObject([{ rule: "@keyframes drain", property: "transform" }]);
    expect(at("src/keyframes.css", 24)[0]?.message).toContain("`var()` inside `transform`");
    expect(at("src/keyframes.css", 28)).toEqual([]);
  });

  it("fails a @keyframes that animates a filter", () => {
    expect(at("src/keyframes.css", 34)).toMatchObject([{ property: "filter" }]);
    expect(at("src/keyframes.css", 34)[0]?.message).toContain("A filter is evaluated again");
  });

  it("fails transition: all", () => {
    expect(at("src/transitions.css", 2)).toMatchObject([{ rule: ".card", property: "all" }]);
    expect(at("src/transitions.css", 2)[0]?.message).toContain("`transition: all`.");
  });

  it("fails a transition that names no property, since that means all", () => {
    expect(at("src/transitions.css", 6)).toMatchObject([{ rule: ".panel", property: "all" }]);
    expect(at("src/transitions.css", 6)[0]?.message).toContain("names no property");
  });

  it("fails only the layout property in a transition list", () => {
    expect(at("src/transitions.css", 10)).toMatchObject([{ rule: ".bar", property: "width" }]);
  });

  it("fails a paint property in transition-property, and reads no property out of a duration", () => {
    expect(at("src/transitions.css", 14)).toMatchObject([{ rule: ".price", property: "color" }]);
    expect(at("src/transitions.css", 15)).toEqual([]);
  });

  it("names a nested rule by its full selector", () => {
    expect(at("src/transitions.css", 20)).toMatchObject([{ rule: ".menu & .item:hover", property: "box-shadow" }]);
  });

  it("fails two animations of one property on one element, and passes two of different properties", () => {
    expect(at("src/two-animations.css", 2)).toMatchObject([{ rule: ".button", property: "transform" }]);
    expect(at("src/two-animations.css", 2)[0]?.message).toContain("`enter` and `throb`");
    expect(at("src/two-animations.css", 6)).toEqual([]);
  });

  it("fails a paint property in literal .animate() keyframes, once per call", () => {
    expect(at("src/motion.ts", 2)).toMatchObject([{ rule: ".animate()", property: "box-shadow" }]);
  });

  it("fails var() inside a transform in literal .animate() keyframes", () => {
    expect(at("src/motion.ts", 6)).toMatchObject([{ rule: ".animate()", property: "transform" }]);
    expect(at("src/motion.ts", 6)[0]?.message).toContain("`var()` inside `transform`");
  });

  it("lists what the source does not settle as unjudged, never as clean", () => {
    expect(result.unjudged).toEqual([
      { file: "src/two-animations.css", line: 10, why: expect.stringContaining("`defined-somewhere-else`") },
      { file: "src/motion.ts", line: 10, why: expect.stringContaining("not written as a literal") },
    ]);
    expect(result.tally.animateCalls).toBe(2);
    expect(formatResult(result)).toContain("Not judged (2)");
  });

  it("finds nothing else", () => {
    expect(findings).toHaveLength(12);
  });

  it("prints the file, the line, the fix and the allow-list key of each finding", () => {
    const report = formatResult(result);

    expect(report).toContain("FAIL animations (12)");
    expect(report).toContain('  src/keyframes.css:7\n    @keyframes flash animates `background-color`. It is a paint property');
    expect(report).toContain('    rule "@keyframes flash", property "background-color"');
    expect(report).toContain("An exception is accepted only in tools/perf/allowed.mts");
  });
});

describe("a project with no animation", () => {
  it("is reported as SKIP with the reason, not as a pass", async () => {
    const result = await checkAnimations({ root: join(fixtures, "none") });

    expect(result.findings).toEqual([]);
    expect(result.skipped).toBe("no transition, no @keyframes and no .animate( call in 1 stylesheet(s) and 1 TypeScript file(s)");
    expect(formatResult(result)).toMatch(/^SKIP animations — no transition/);
    expect(formatResult(result)).not.toContain("PASS");
  });

  it("is still a SKIP when the only animation code cannot be judged from source", async () => {
    const result = await checkAnimations({ root: join(fixtures, "unjudged") });

    expect(result.skipped).toBe("nothing could be judged from source in 1 stylesheet(s) and 0 TypeScript file(s)");
    expect(result.unjudged).toEqual([{ file: "src/ui.css", line: 2, why: expect.stringContaining("from a variable") }]);
    expect(formatResult(result)).not.toContain("PASS");
  });
});

describe("the allow-list", () => {
  const root = join(fixtures, "allowed");

  it("is the project's tools/perf/allowed.mts, and accepts a finding with its reason", async () => {
    const result = await checkAnimations({ root });

    expect(result.findings).toEqual([]);
    expect(result.accepted).toMatchObject([
      { finding: { file: "src/button.css", line: 2 }, reason: "Hover feedback. Runs on a pointer event, never on live data." },
    ]);
    expect(formatResult(result)).toContain("Accepted by tools/perf/allowed.mts (1):");
  });

  it("accepts nothing without an entry", async () => {
    const result = await checkAnimations({ root, allowed: [] });

    expect(result.findings).toMatchObject([{ file: "src/button.css", line: 2, property: "background-color" }]);
  });

  it("accepts only the finding it names: another property in the same rule still fails", async () => {
    const entry = { file: "src/button.css", rule: ".button:hover", property: "color", reason: "Wrong property." };
    const result = await checkAnimations({ root, allowed: [entry] });

    expect(result.findings.map((finding) => finding.file)).toEqual(["src/button.css", "tools/perf/allowed.mts"]);
    expect(result.findings[1]?.message).toContain("This entry accepts nothing");
  });

  it("ships empty, in the shape the check accepts", () => {
    expect(checkAllowed(shippedAllowList)).toEqual({ animations: [], motion: [] });
  });

  it("refuses an entry with no reason", () => {
    const entry = { file: "src/button.css", rule: ".button:hover", property: "background-color", reason: " " };

    expect(() => checkAllowed({ animations: [entry] })).toThrow(AllowedError);
    expect(() => checkAllowed({ animations: [entry] })).toThrow('animations[0] has no "reason"');
  });
});

describe("the command", () => {
  it("exits 0 and prints SKIP when there is nothing to judge", () => {
    const { status, stdout } = runCheck(join(fixtures, "none"));

    expect(status).toBe(0);
    expect(stdout).toMatch(/^SKIP animations/);
  });

  it("exits 0 and prints PASS for a clean project", () => {
    const { status, stdout } = runCheck(join(fixtures, "clean"));

    expect(status).toBe(0);
    expect(stdout).toMatch(/^PASS animations/);
  });

  it("exits 1 on findings", () => {
    const { status, stdout } = runCheck(join(fixtures, "broken"));

    expect(status).toBe(1);
    expect(stdout).toMatch(/^FAIL animations \(12\)/);
  });

  it("exits 2 when it cannot run", () => {
    const { status, stderr } = runCheck(join(fixtures, "no-such-project"));

    expect(status).toBe(2);
    expect(stderr).toContain("perf:check could not run");
  });
});

describe("the stylesheet scanner", () => {
  it("keeps line numbers across comments and ignores braces inside strings and comments", () => {
    const css = ['.a::after { content: "}{;"; }', "/* .b { transition: all; }", "   still a comment */", ".c {", "  transition: all 1s", "}"].join("\n");

    expect(scanCss(css)).toEqual([
      { line: 1, property: "content", value: '" "', rule: ".a::after" },
      { line: 5, property: "transition", value: "all 1s", rule: ".c" },
    ]);
  });

  it("reads a rule inside @media by its selector, and a vendor-prefixed property by its plain name", () => {
    const css = "@media (min-width: 40em) { .a { -webkit-transition: width 1s; } }";

    expect(scanCss(css)).toEqual([{ line: 1, property: "transition", value: "width 1s", rule: ".a" }]);
  });
});

describe("the .animate( scanner", () => {
  it("reads both keyframe forms and drops offset, easing and composite", () => {
    const source = [
      'el.animate([{ opacity: 0, offset: 0, easing: "ease-in" }, { "background-color": "red", composite: "add" }], 200);',
      "el.animate({ translate: [a, b], cssFloat: [c, d] }, 200);",
    ].join("\n");

    expect(scanAnimateCalls(source)).toEqual([
      {
        line: 1,
        properties: [
          { property: "opacity", value: "0" },
          { property: "background-color", value: '"red"' },
        ],
      },
      {
        line: 2,
        properties: [
          { property: "translate", value: "[a, b]" },
          { property: "float", value: "[c, d]" },
        ],
      },
    ]);
  });

  it("does not judge keyframes built with a spread", () => {
    expect(scanAnimateCalls("el.animate([{ ...from }, { opacity: 1 }], 200);")).toEqual([
      { line: 1, unjudged: "a keyframe is built with a spread or a computed key" },
    ]);
  });
});

function runCheck(root: string): { status: number | null; stdout: string; stderr: string } {
  const { status, stdout, stderr } = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });

  return { status, stdout, stderr };
}
