import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseArguments, UsageError } from "../files/tools/visual/lib/arguments.mts";

describe("the jitter command's arguments", () => {
  it("captures three times when given nothing", () => {
    expect(parseArguments([])).toEqual({ mode: "capture", runs: 3 });
  });

  it("captures as many times as --runs says", () => {
    expect(parseArguments(["--runs", "5"])).toEqual({ mode: "capture", runs: 5 });
  });

  it("refuses a single capture: one capture has nothing to differ from", () => {
    expect(() => parseArguments(["--runs", "1"])).toThrow(UsageError);
    expect(() => parseArguments(["--runs", "many"])).toThrow(UsageError);
  });

  it("compares the folders it is given, as absolute paths", () => {
    expect(parseArguments(["one", "/tmp/two"])).toEqual({ mode: "compare", directories: [resolve("one"), "/tmp/two"] });
  });

  it("refuses a single folder", () => {
    expect(() => parseArguments(["one"])).toThrow(/at least two/);
  });

  it("refuses --runs together with folders", () => {
    expect(() => parseArguments(["--runs", "3", "one", "two"])).toThrow(/not both/);
  });

  it("refuses an argument it does not know", () => {
    expect(() => parseArguments(["--threshold", "0"])).toThrow(/unknown argument "--threshold"/);
  });
});
