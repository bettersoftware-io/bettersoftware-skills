import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY = dirname(dirname(fileURLToPath(import.meta.url)));
const BIOME = join(REPOSITORY, "node_modules/.bin/biome");

// A file an add-on owns is compared byte for byte by the next update: one
// that differs from what was installed is refused as edited. Such a file is
// written for the scope `@app`, and a project's formatter runs over it. Under
// a longer scope the formatter wrapped an import of the visual host, and the
// next update of `visual` refused a file nobody had edited. So every file an
// add-on owns that the formatter reads and that names the scope must come out
// of the formatter as it went in, under any scope.

interface Owned {
  addon: string;
  /** Path in a project. */
  path: string;
  text: string;
}

/** Every file an add-on owns (not a starting file) that Biome reads in a project and that names the scope. */
function listOwnedFilesThatNameTheScope(): Owned[] {
  return readdirSync(join(REPOSITORY, "addons"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name: addon }) => {
      const files = join(REPOSITORY, "addons", addon, "files");
      const manifest = JSON.parse(readFileSync(join(REPOSITORY, "addons", addon, "addon.json"), "utf8")) as { startingFiles?: string[] };
      const starting = manifest.startingFiles ?? [];

      return listFiles(files)
        .map((file) => relative(files, file))
        // Biome reads neither `tools/` nor a hidden folder at the root.
        .filter((path) => /\.(ts|tsx|mts|json|css)$/.test(path) && !path.startsWith("tools/") && !path.startsWith("."))
        .filter((path) => !starting.some((pattern) => (pattern.endsWith("/") ? path.startsWith(pattern) : path === pattern)))
        .map((path) => ({ addon, path, text: readFileSync(join(files, path), "utf8") }))
        .filter(({ text }) => text.includes("@app/"));
    });
}

describe("a file an add-on owns that names the project's scope", () => {
  const owned = listOwnedFilesThatNameTheScope();

  it("is found: the visual host, for one", () => {
    expect(owned.map(({ addon, path }) => `${addon} ${path}`)).toContain("visual packages/client-react/tests/visual/host/main.tsx");
  });

  it.each(["@app", "@skills-demo", "@ci-organisation-with-a-long-name"])("comes out of the formatter as it went in, under the scope %s", (scope) => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "scope-stable-")));
    const write = (path: string, text: string): void => {
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), text);
    };

    write("biome.json", readFileSync(join(REPOSITORY, "addons/format-lint/files/biome.json"), "utf8"));
    write("tools/format-lint/biome.base.json", readFileSync(join(REPOSITORY, "addons/format-lint/files/tools/format-lint/biome.base.json"), "utf8"));
    write(".gitignore", "node_modules/\n");

    for (const { path, text } of owned) {
      write(path, text.replaceAll("@app/", `${scope}/`));
    }

    const ran = spawnSync(BIOME, ["format", "--write", "--colors=off", "."], { cwd: project, encoding: "utf8" });

    expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);

    for (const { path, text } of owned) {
      expect(readFileSync(join(project, path), "utf8"), path).toBe(text.replaceAll("@app/", `${scope}/`));
    }
  });
});

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    return entry.isDirectory() ? listFiles(path) : [path];
  });
}
