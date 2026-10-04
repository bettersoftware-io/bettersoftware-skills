import { describe, expect, it } from "vitest";

import { findUnexplainedIgnores } from "../files/tools/coverage/lib/ignores.mts";
import { createFolder } from "./support.mts";

describe("comments that leave code out of the measurement", () => {
  it("finds one that gives no reason, with its line", () => {
    const root = createFolder({
      "src/size.ts": "export function describeSize(width: number): string {\n  /* v8 ignore next 3 */\n  if (width === 0) {\n    return 'hidden';\n  }\n\n  return 'shown';\n}\n",
    });

    expect(findUnexplainedIgnores(root, ["src/size.ts"])).toEqual([{ file: "src/size.ts", line: 2 }]);
  });

  it("accepts one that says why after --", () => {
    const root = createFolder({ "src/size.ts": "/* v8 ignore next 3 -- only a real browser reports a width of 0 */\nexport const size = 1;\n" });

    expect(findUnexplainedIgnores(root, ["src/size.ts"])).toEqual([]);
  });

  it("does not take a bare -- for a reason", () => {
    const root = createFolder({ "src/size.ts": "/* v8 ignore next -- */\nexport const size = 1;\n" });

    expect(findUnexplainedIgnores(root, ["src/size.ts"])).toEqual([{ file: "src/size.ts", line: 1 }]);
  });

  it("asks for the reason at the start of a range, not at its stop", () => {
    const root = createFolder({
      "src/size.ts": "/* v8 ignore start -- only reached in a real browser */\nexport const size = 1;\n/* v8 ignore stop */\n",
    });

    expect(findUnexplainedIgnores(root, ["src/size.ts"])).toEqual([]);
  });

  it("sees the istanbul and c8 spellings, and a line comment", () => {
    const root = createFolder({
      "src/size.ts": "/* istanbul ignore next */\nexport const a = 1;\n// c8 ignore next\nexport const b = 2;\n",
    });

    expect(findUnexplainedIgnores(root, ["src/size.ts"]).map(({ line }) => line)).toEqual([1, 3]);
  });

  it("passes over a file that is no longer there", () => {
    expect(findUnexplainedIgnores(createFolder(), ["src/gone.ts"])).toEqual([]);
  });
});
