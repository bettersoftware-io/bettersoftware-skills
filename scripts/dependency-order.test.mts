import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { listAddons } from "./add-to-project.mts";
import { createProject } from "./create-project.mts";
import { renameScope, sortDependencies } from "./lib/install.mts";

const REPOSITORY = dirname(dirname(fileURLToPath(import.meta.url)));

// A package.json here is written for the scope `@app`, with its dependencies
// in name order. Where another scope sorts is not where `@app` does:
// `@zeta/shared` comes after `@playwright/test`, and the starter's own
// packages moved too. The hygiene add-on's version check then failed a new
// project on its first gate, and CI's one scope sorts early and never showed
// it. So the order is held here for every file, under scopes that sort in
// each place.

const MAPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** `<file>: <map>` for each dependency map of a package.json under `root` that is not in name order. */
function findUnsorted(root: string): string[] {
  return listFiles(root)
    .filter((file) => file.endsWith("/package.json"))
    .flatMap((file) => {
      const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, string> | undefined>;

      return MAPS.filter((map) => {
        const names = Object.keys(manifest[map] ?? {});

        return names.join("\n") !== [...names].sort().join("\n");
      }).map((map) => `${relative(root, file)}: ${map}`);
    });
}

describe("the dependencies of a package.json this repository ships", () => {
  it.each(["starter", "addons"])("are in name order as written, in %s", (folder) => {
    expect(findUnsorted(join(REPOSITORY, folder))).toEqual([]);
  });

  it("are found: the starter and an add-on each have a package.json with more than one scoped dependency", () => {
    const e2e = JSON.parse(readFileSync(join(REPOSITORY, "addons/e2e/files/packages/e2e/package.json"), "utf8")) as { devDependencies: Record<string, string> };

    expect(Object.keys(e2e.devDependencies)).toEqual(["@app/client-react", "@app/shared", "@playwright/test", "@types/node"]);
  });

  // Each sorts in another place: before `@playwright` and `@rx-state`, between `@rx-state` and `@types`, and after every `@` name a project has.
  it.each(["@ci-organisation-with-a-long-name", "@skills-demo", "@zeta"])(
    "are in name order in a project created with every add-on under the scope %s",
    (scope) => {
      const target = join(mkdtempSync(join(tmpdir(), "dependency-order-")), "project");

      mkdirSync(target);

      const { destination } = createProject({ target, scope, addons: listAddons().map(({ name }) => name) });
      const e2e = JSON.parse(readFileSync(join(destination, "packages/e2e/package.json"), "utf8")) as { devDependencies: Record<string, string> };

      expect(findUnsorted(destination)).toEqual([]);
      // The scope did reach the file the add-on brought, and the starter's own.
      expect(Object.keys(e2e.devDependencies)).toContain(`${scope}/shared`);
      expect(readFileSync(join(destination, "packages/client-core/package.json"), "utf8")).toContain(`"${scope}/domain"`);
      // The copy kept as the template is the file as it was written: an update must find them equal.
      expect(readFileSync(join(destination, "tools/templates/e2e.packages__e2e__package.json.txt"), "utf8")).toBe(readFileSync(join(destination, "packages/e2e/package.json"), "utf8"));
    },
  );
});

describe("renaming the scope in one file", () => {
  const manifest = (devDependencies: Record<string, string>, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ name: "@app/e2e", ...extra, devDependencies }, null, 2)}\n`;

  it("puts the dependencies of a package.json back in name order", () => {
    const renamed = renameScope("package.json", manifest({ "@app/shared": "workspace:*", "@playwright/test": "1.63.0", "@types/node": "^26" }), "@app", "@zeta");

    expect(Object.keys((JSON.parse(renamed) as { devDependencies: object }).devDependencies)).toEqual(["@playwright/test", "@types/node", "@zeta/shared"]);
    expect(renamed).toContain('"name": "@zeta/e2e"');
  });

  it("sorts every kind of dependency map, and no other map", () => {
    const text = `${JSON.stringify({
      scripts: { test: "x", build: "y" },
      dependencies: { b: "1", a: "1" },
      devDependencies: { b: "1", a: "1" },
      optionalDependencies: { b: "1", a: "1" },
      peerDependencies: { b: "1", a: "1" },
    })}\n`;
    const sorted = JSON.parse(sortDependencies(text)) as Record<string, Record<string, string>>;

    expect(Object.keys(sorted.scripts ?? {})).toEqual(["test", "build"]);

    for (const map of MAPS) {
      expect(Object.keys(sorted[map] ?? {}), map).toEqual(["a", "b"]);
    }
  });

  it("orders by character code, as the version check does: capitals first, and no locale", () => {
    expect(Object.keys((JSON.parse(sortDependencies('{"dependencies":{"a":"1","B":"1","@x/y":"1","_z":"1"}}')) as { dependencies: object }).dependencies)).toEqual(["@x/y", "B", "_z", "a"]);
  });

  it("leaves a file that is already in order as it was, byte for byte", () => {
    const text = '{ "name": "@app/x",\n\t"devDependencies": { "a": "1", "b": "1" } }';

    expect(sortDependencies(text)).toBe(text);
    expect(renameScope("package.json", text, "@app", "@app")).toBe(text);
  });

  it("leaves a file that is not a package.json in the order it has, and one that is not JSON as it is", () => {
    const text = manifest({ "@app/shared": "workspace:*", "@playwright/test": "1.63.0" });

    expect(renameScope("tsconfig.json", text, "@app", "@zeta")).toBe(text.replaceAll("@app/", "@zeta/"));
    expect(renameScope("package.json", '{ "@app/x": ', "@app", "@zeta")).toBe('{ "@zeta/x": ');
    expect(sortDependencies("[]")).toBe("[]");
  });
});

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    return entry.isDirectory() && entry.name !== "node_modules" ? listFiles(path) : entry.isFile() ? [path] : [];
  });
}
