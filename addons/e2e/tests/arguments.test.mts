import { describe, expect, it } from "vitest";

import { parseArguments, UsageError } from "../files/tools/e2e/lib/arguments.mts";

describe("what pnpm e2e was asked", () => {
  it("is every mode and nothing for the test runner, when nothing is given", () => {
    expect(parseArguments([])).toEqual({ modes: [], forwarded: [] });
  });

  it("takes each --mode, in either spelling, once", () => {
    expect(parseArguments(["--mode", "sim", "--mode=fullstack", "--mode", "sim"])).toEqual({ modes: ["sim", "fullstack"], forwarded: [] });
  });

  it("hands everything else to the test runner, in the order given", () => {
    expect(parseArguments(["src/sim/priceList.spec.ts", "--mode", "sim", "-g", "selects the row", "--headed"])).toEqual({
      modes: ["sim"],
      forwarded: ["src/sim/priceList.spec.ts", "-g", "selects the row", "--headed"],
    });
  });

  it("hands on what follows a --, and does not read a --mode there as its own", () => {
    expect(parseArguments(["--mode", "sim", "--", "--mode", "x", "--ui"])).toEqual({ modes: ["sim"], forwarded: ["--mode", "x", "--ui"] });
  });

  it("refuses a --mode with no name after it", () => {
    expect(() => parseArguments(["--mode"])).toThrow(UsageError);
    expect(() => parseArguments(["--mode", "--headed"])).toThrow('"--mode" needs the name of a mode');
  });
});
