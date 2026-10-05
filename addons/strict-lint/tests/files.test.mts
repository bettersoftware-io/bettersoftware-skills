import { describe, expect, it } from "vitest";

import { listSourceFiles } from "../files/tools/strict-lint/lib/files.mts";
import { CouldNotRun, firstLine, installedTools } from "../files/tools/strict-lint/lib/run.mts";
import { createFolder } from "./support.mts";

describe("the files the checks have to judge", () => {
  it("are the .ts, .tsx and .mts files, in order", () => {
    const folder = createFolder({ "src/b.tsx": "", "src/a.ts": "", "vitest.config.mts": "", "src/page.css": "", "README.md": "", "src/a.json": "" });

    expect(listSourceFiles(folder)).toEqual(["src/a.ts", "src/b.tsx", "vitest.config.mts"]);
  });

  it("leave out installed and generated folders at any depth", () => {
    const folder = createFolder({
      "packages/a/src/a.ts": "",
      "node_modules/x/x.ts": "",
      "packages/a/node_modules/x/x.ts": "",
      "packages/a/dist/a.ts": "",
      "packages/a/coverage/a.ts": "",
      "packages/a/reports/a.ts": "",
      "packages/a/.turbo/a.ts": "",
    });

    expect(listSourceFiles(folder)).toEqual(["packages/a/src/a.ts"]);
  });

  it("leave out tools/ at the root, and keep a package's own folder called tools", () => {
    const folder = createFolder({ "tools/arch/run.mts": "", "packages/a/tools/build.ts": "" });

    expect(listSourceFiles(folder)).toEqual(["packages/a/tools/build.ts"]);
  });

  it("are none in a folder that does not exist", () => {
    expect(listSourceFiles("/nowhere/at/all")).toEqual([]);
  });
});

describe("running an installed tool", () => {
  it("could not run when the tool is not installed, and says how to install it", () => {
    const run = installedTools(createFolder());

    expect(() => run("knip", [])).toThrow(new CouldNotRun("knip is not installed (there is no node_modules/.bin/knip). Run `pnpm install`."));
  });

  it("gives the first line that says anything for a tool that stopped", () => {
    expect(firstLine("", "\n\n  Oops: bad config  \n  at somewhere\n")).toBe("Oops: bad config");
  });

  it("says so when the tool printed nothing", () => {
    expect(firstLine("", "\n")).toBe("it printed nothing");
  });
});
