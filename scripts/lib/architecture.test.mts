import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { blankComments, declarePackages, renderDeclaration } from "./architecture.mts";

const E2E = { "packages/e2e": { role: "e2e" } };

describe("declaring a package in the architecture config", () => {
  it("adds the entry as the last line of the packages map, and touches nothing else", () => {
    const result = declarePackages(createConfig(), E2E);

    expect(result.added).toEqual(['"packages/e2e": { role: "e2e" },']);
    expect(result.byHand).toEqual([]);
    expect(result.text).toBe(
      createConfig().replace(
        '    "packages/server": { role: "server" },\n',
        '    "packages/server": { role: "server" },\n    "packages/e2e": { role: "e2e" },\n',
      ),
    );
  });

  it("gives the last entry its comma when it had none, before a comment that follows it", () => {
    const config = 'export default {\n  packages: {\n    "packages/domain": { role: "domain" } // the centre\n  },\n};\n';

    expect(declarePackages(config, E2E).text).toBe(
      'export default {\n  packages: {\n    "packages/domain": { role: "domain" }, // the centre\n    "packages/e2e": { role: "e2e" },\n  },\n};\n',
    );
  });

  it("adds to a map that is empty", () => {
    expect(declarePackages("export default {\n  packages: {\n  },\n};\n", E2E).text).toBe(
      'export default {\n  packages: {\n    "packages/e2e": { role: "e2e" },\n  },\n};\n',
    );
  });

  it("is not misled by a brace in a string or in a comment", () => {
    const config =
      'export default {\n  packages: {\n    // } not the end\n    "packages/odd}": { role: "leaf" /* } */ },\n  },\n  adapters: [],\n};\n';

    expect(declarePackages(config, E2E).text).toBe(config.replace("  },\n  adapters", '    "packages/e2e": { role: "e2e" },\n  },\n  adapters'));
  });

  it("leaves an entry the project already has as it is, in either kind of quote", () => {
    const double = createConfig().replace('"packages/server": { role: "server" }', '"packages/e2e": { role: "integration" }');
    const single = createConfig().replace('"packages/server"', "'packages/e2e'");

    expect(declarePackages(double, E2E)).toEqual({ added: [], byHand: [] });
    expect(declarePackages(single, E2E)).toEqual({ added: [], byHand: [] });
  });

  it("does not take an entry that is commented out for a declaration", () => {
    const config = 'export default {\n  packages: {\n    "packages/domain": { role: "domain" },\n    // "packages/e2e": { role: "e2e" },\n    /* "packages/e2e": {} */\n  },\n};\n';

    expect(declarePackages(config, E2E).text).toBe(config.replace("  },\n};", '    "packages/e2e": { role: "e2e" },\n  },\n};'));
  });

  it("reads a quote in a comment as part of the comment", () => {
    const config = "export default {\n  packages: {\n    // the client's own\n    \"packages/web\": { role: \"client\" },\n  },\n};\n";

    expect(declarePackages(config, E2E).added).toHaveLength(1);
  });

  it("changes nothing the second time", () => {
    const once = declarePackages(createConfig(), E2E).text as string;

    expect(declarePackages(once, E2E)).toEqual({ added: [], byHand: [] });
  });

  it("adds several entries, in the order given", () => {
    const result = declarePackages(createConfig(), { ...E2E, "packages/icons": { role: "leaf", typesOnly: true, npm: ["rxjs"] } });

    expect(result.text).toContain('    "packages/e2e": { role: "e2e" },\n    "packages/icons": { role: "leaf", typesOnly: true, npm: ["rxjs"] },\n  },\n');
  });

  it("hands back the line to write when the file has no packages map it can read", () => {
    const line = ['"packages/e2e": { role: "e2e" },'];

    expect(declarePackages("export default buildConfig();\n", E2E)).toEqual({ added: [], byHand: line });
    expect(declarePackages('export default { packages: { "packages/domain": { role: "domain" } } };\n', E2E)).toEqual({ added: [], byHand: line });
    expect(declarePackages('export default {\n  packages: {\n    "packages/domain": { role: "domain" },\n', E2E)).toEqual({ added: [], byHand: line });
    expect(declarePackages('export default {\n  packages: {\n    "packages/domain": "unclosed,\n  },\n};\n', E2E)).toEqual({ added: [], byHand: line });
    expect(declarePackages('export default {\n  packages: {\n    /* never closed\n  },\n};\n', E2E)).toEqual({ added: [], byHand: line });
  });

  it("blanks a comment without moving anything, the last line of a file included", () => {
    expect(blankComments('a /* b\nc */ "//d" // e')).toBe('a     \n     "//d"     ');
  });

  it("writes a key that is not a plain name in quotes", () => {
    expect(renderDeclaration({ role: "leaf", "odd-key": true })).toBe('{ role: "leaf", "odd-key": true }');
    expect(renderDeclaration({})).toBe("{}");
  });

  it("reads the starter's own config and the kit's example", () => {
    const repository = join(import.meta.dirname, "..", "..");

    for (const file of ["starter/architecture.config.mts", "kit/architecture.config.example.mts"]) {
      const text = readFileSync(join(repository, file), "utf8");
      const result = declarePackages(text, { "packages/added-by-a-test": { role: "leaf" } });

      expect(result.byHand, file).toEqual([]);
      expect(result.text, file).toMatch(/\n {4}"packages\/added-by-a-test": \{ role: "leaf" \},\n {2}\},\n/);
    }
  });
});

function createConfig(): string {
  return [
    'import type { ArchitectureConfig } from "./tools/arch/gates/lib/config.mts";',
    "",
    "const config: ArchitectureConfig = {",
    "  packages: {",
    "    // The centre.",
    '    "packages/domain": { role: "domain", npm: ["rxjs"] },',
    '    "packages/client-react": {',
    '      role: "client",',
    '      entry: ["main.tsx"],',
    "    },",
    '    "packages/server": { role: "server" },',
    "  },",
    "",
    '  adapters: ["packages/domain/src/simulators"],',
    "};",
    "",
    "export default config;",
    "",
  ].join("\n");
}
