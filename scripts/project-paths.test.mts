import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { addToProject, compareWithTemplates, describeComparison, describeYours, isUnitName } from "./add-to-project.mts";
import { createProject, ProjectError } from "./create-project.mts";
import { InstallError, listProjectFolders, projectHas, readProjectFile, readProjectText } from "./lib/install.mts";
import { differenceOf, MOST_COMPARED_CELLS, printable, showSafely } from "./lib/templates.mts";

// The installer compares a project's own files with templates and prints the
// difference. So what it reads can end up on a screen, and the paths it reads
// come from places a project controls: its record, its files, the command
// line. A read follows the rule a write always did: a plain place inside the
// project, with no link on the way.

const SCRIPTS = import.meta.dirname;
const SECRET = "TOP-SECRET-KEY-1234";

describe("a path of the project that is read", () => {
  it.each(["../outside.txt", "/etc/passwd", "a/../../outside.txt", ""])("is refused when it is %j", (path) => {
    const { project } = createWorld();

    expect(() => projectHas(project, path)).toThrow(InstallError);
    expect(() => readProjectFile(project, path)).toThrow(InstallError);
  });

  it("is refused when it is a link, or is reached through one, whether the link leads outside or not", () => {
    const { project, root } = createWorld();

    symlinkSync(join(root, "secret.txt"), join(project, "SECURITY.md"));
    symlinkSync(root, join(project, "linked"));
    symlinkSync("package.json", join(project, "inner-link.json"));

    for (const path of ["SECURITY.md", "linked/secret.txt", "inner-link.json"]) {
      expect(() => readProjectText(project, path), path).toThrow(/outside the project, or reaches it through a link/);
      expect(() => projectHas(project, path), path).toThrow(InstallError);
    }
  });

  it("is read when it is a plain file, and is not there when nothing is", () => {
    const { project } = createWorld();

    expect(readProjectText(project, "package.json")).toContain('"name": "p"');
    expect(projectHas(project, "packages/web/package.json")).toBe(true);
    expect(projectHas(project, "packages/none/package.json")).toBe(false);
  });

  it("lists the folders of a folder, and never a link to one", () => {
    const { project, root } = createWorld();

    symlinkSync(root, join(project, "packages/linked"));

    expect(listProjectFolders(project, "packages")).toEqual(["web"]);
    expect(listProjectFolders(project, "no-such-folder")).toEqual([]);
  });
});

describe("a file of the project that is a link to something else", () => {
  it("stops a kit update before anything is written, and is never printed", () => {
    const { repository, project, root } = createWorld();

    symlinkSync(join(root, "secret.txt"), join(project, ".nvmrc"));

    expect(() => addToProject({ project, unit: "kit", repository })).toThrow('".nvmrc" is outside the project, or reaches it through a link — nothing was changed');
    expect(projectHas(project, "tools/installed.json")).toBe(false);
  });

  it("is listed as refused by --compare, which opens neither it nor what it points at", () => {
    const { repository, project, root } = createWorld();

    addToProject({ project, unit: "kit", repository });
    symlinkSync(join(root, "secret.txt"), join(project, ".nvmrc"));

    const compared = compareWithTemplates({ project, repository });
    const printed = describeComparison(compared);

    expect(compared.find(({ owned }) => owned === ".nvmrc")).toMatchObject({ state: "refused", lines: [] });
    expect(printed).toContain("  refused  .nvmrc — it is a link, or is reached through one, so it was not opened and is not compared");
    expect(printed).not.toContain(SECRET);
  });

  it("is refused by --compare when it is the project's copy of a template that is the link", () => {
    const { repository, project, root } = createWorld();

    addToProject({ project, unit: "kit", repository });
    writeFileSync(join(project, ".nvmrc"), "24\n");
    replaceWithLink(project, "tools/arch/templates/.nvmrc.txt", join(root, "secret.txt"));

    const printed = describeComparison(compareWithTemplates({ project, repository }));

    expect(printed).toContain("  refused  .nvmrc");
    expect(printed).not.toContain(SECRET);
  });

  it("stops an add-on update when a package.json it reads for the scope is a link, without quoting what the link holds", () => {
    const { repository, project, root } = createWorld();

    addToProject({ project, unit: "kit", repository });
    replaceWithLink(project, "packages/web/package.json", join(root, "secret.txt"));

    let message = "";

    try {
      addToProject({ project, unit: "demo", repository });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("reaches it through a link");
    expect(message).not.toContain(SECRET);
  });

  it("does not quote a record that is not JSON in the message that says so", () => {
    const { repository, project } = createWorld();

    write(project, "tools/installed.json", `${SECRET} is not json`);

    expect(() => addToProject({ project, unit: "kit", repository })).toThrow("tools/installed.json is not JSON, so what this project has installed cannot be told — nothing was changed");
  });
});

describe("a name that is joined into a path", () => {
  it.each(["../../evil", "..", "demo/../../evil", "/abs", "Demo", "", "a b"])("is no unit when it is %j", (name) => {
    expect(isUnitName(name)).toBe(false);
  });

  it("is a unit when it is a folder's plain name", () => {
    expect(["kit", "ci-security", "e2e"].every(isUnitName)).toBe(true);
  });

  it("installs nothing from outside the repository's add-ons, though a folder with an add-on's files is there", () => {
    const { repository, project, root } = createWorld();

    addToProject({ project, unit: "kit", repository });
    write(root, "evil/addon.json", JSON.stringify({ name: "evil", summary: "e" }));
    write(root, "evil/files/EVIL.md", "from outside the repository\n");

    expect(() => addToProject({ project, unit: "../../evil", repository })).toThrow('there is no add-on called "../../evil" — available: demo');
    expect(projectHas(project, "EVIL.md")).toBe(false);
    expect(() => compareWithTemplates({ project, repository, unit: "../../evil" })).toThrow(InstallError);
  });

  it("refuses an option that is a path, on the command line", () => {
    const { repository, project } = createWorldWithChoice();

    expect(() => addToProject({ project, unit: "demo:../../../outside", repository })).toThrow('the add-on "demo" has no option "../../../outside" — it has: a, b');
  });

  it("does not follow an option that is a path, in the project's record: it is read as no option at all", () => {
    const { repository, project, root } = createWorldWithChoice();

    addToProject({ project, unit: "demo", repository });
    write(root, "outside/files/OUTSIDE.md", "from outside the add-on\n");
    write(project, "OUTSIDE.md", "from outside the add-on\n");

    const record = JSON.parse(readProjectText(project, "tools/installed.json")) as Record<string, { choice?: string }>;

    (record.demo as { choice?: string }).choice = "../../../../outside";
    write(project, "tools/installed.json", JSON.stringify(record));

    const result = addToProject({ project, unit: "demo:b", repository });

    // Nothing of the folder the record pointed at was read as an option's files.
    expect(result.notes.join("\n")).not.toContain("OUTSIDE.md");
    expect(result.choiceRemoved).toEqual(["A.md"]);
    expect(readProjectText(project, "OUTSIDE.md")).toBe("from outside the add-on\n");
  });

  it("refuses an add-on or an option that is a path when a project is created, before anything is written", () => {
    const target = join(mkdtempSync(join(tmpdir(), "project-paths-")), "project");

    mkdirSync(target);

    expect(() => createProject({ target, addons: ["../../x"] })).toThrow(ProjectError);
    expect(() => createProject({ target, addons: ["ci-security:../../x"] })).toThrow('the add-on "ci-security" has no option "../../x"');
    expect(projectHas(target, "package.json")).toBe(false);
  });
});

describe("the name of a template's copy", () => {
  it("is refused when two starting files would share it: the name is flat, and is never read back into a path", () => {
    const { repository, project } = createWorld();

    addToProject({ project, unit: "kit", repository });
    write(repository, "addons/demo/addon.json", JSON.stringify({ name: "demo", summary: "d", startingFiles: ["a__b/c.md", "a/b__c.md"] }));
    write(repository, "addons/demo/files/a__b/c.md", "one\n");
    write(repository, "addons/demo/files/a/b__c.md", "two\n");

    expect(() => addToProject({ project, unit: "demo", repository })).toThrow(
      'the add-on "demo" cannot be installed: its starting files a/b__c.md and a__b/c.md would both keep their template as tools/templates/demo.a__b__c.md.txt. Rename one of them',
    );
    expect(projectHas(project, "a/b__c.md")).toBe(false);
  });

  it("names nothing outside the project, whatever a file under tools/templates is called: a name there is only ever made from a path, never turned into one", () => {
    const { repository, project } = createWorld();

    addToProject({ project, unit: "kit", repository });
    addToProject({ project, unit: "demo", repository });
    write(project, "tools/templates/demo...__...__outside.md.txt", "a copy with a name that looks like a path\n");

    const result = addToProject({ project, unit: "demo", repository });

    expect(result.files.written).toEqual([]);
    expect(compareWithTemplates({ project, repository, unit: "demo" }).map(({ owned }) => owned)).toEqual(["POLICY.md"]);
  });
});

describe("what is printed from a file of the project", () => {
  it("has every control character written out, so a file cannot write to the terminal it is listed on", () => {
    expect(showSafely("+ \u001b]0;title\u0007\u001b[2Jtext\ttab\u009b1m\u007f")).toBe("+ \\x1b]0;title\\x07\\x1b[2Jtext\ttab\\x9b1m\\x7f");
  });

  it("is so in the update's own output", () => {
    const { repository, project } = createWorld();

    write(project, ".nvmrc", "\u001b[2J24\n");

    const printed = describeYours(addToProject({ project, unit: "kit", repository })).join("\n");

    expect(printed).toContain("+ \\x1b[2J24");
    expect(printed).not.toContain("\u001b");
  });

  it("is cut when one line is very long", () => {
    expect(showSafely(`+ ${"x".repeat(400)}`)).toBe(`+ ${"x".repeat(298)}… (102 more characters)`);
  });

  it.each([
    ["holds a zero byte", Buffer.from("PNG\u0000\u0001binary")],
    ["is larger than 512 KB", Buffer.from("line\n".repeat(110_000))],
  ])("is not shown at all when the file %s", (_what, yours) => {
    expect(differenceOf("26\n", yours)).toEqual(["  (not shown: the project's file is not text, or is larger than 512 KB)"]);
  });

  it("is not compared at all when the two files have too many lines, before the comparison's table is built", () => {
    const template = "a\n".repeat(3000);
    const yours = "b\n".repeat(Math.ceil(MOST_COMPARED_CELLS / 3000));
    const startedAt = Date.now();

    expect(differenceOf(template, yours)).toEqual(["  (not shown: the two files have too many lines to compare here)"]);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("has the marks that reorder a line, and the Unicode line breaks, written out", () => {
    expect(showSafely("+ safe\u202etxt.exe\u2066x\u2028y")).toBe("+ safe\\u202etxt.exe\\u2066x\\u2028y");
  });

  it("keeps a message's own line breaks and tabs, and writes out every other control character in it", () => {
    expect(printable("merged   a\u001b[2J.json\n\tb\u0007\rc")).toBe("merged   a\\x1b[2J.json\n\tb\\x07\\x0dc");
  });

  it("every message the two scripts print goes through that", () => {
    for (const file of ["add-to-project.mts", "create-project.mts"]) {
      const printed = [...readFileSync(join(SCRIPTS, file), "utf8").matchAll(/console\.(?:log|error)\(([^\n]*)/g)].map(([, argument]) => argument);

      expect(printed.length).toBeGreaterThan(0);
      expect(printed.filter((argument) => !argument.includes("printable("))).toEqual([]);
    }
  });

  it("is the difference, for a small text file", () => {
    expect(differenceOf("26\n", Buffer.from("24\n"))).toEqual(["- 26", "+ 24"]);
  });
});

describe("the scripts' own source", () => {
  const FS_CALL = /\b(existsSync|readFileSync|statSync|lstatSync|readdirSync|rmSync|writeFileSync)\(([^\n]*)/g;
  const callsIn = (file: string): string[] => [...readFileSync(join(SCRIPTS, file), "utf8").matchAll(FS_CALL)].map(([call]) => call);

  it("opens no project path in add-to-project.mts but through the helpers beside assertInside: every other file call names this repository", () => {
    // What a call may be about: the repository, an add-on's folder in it, the starter, or a folder of either.
    const ofTheRepository = /\((join\()?(repository|addon|starter|source|section|root|folder)\b/;

    expect(callsIn("add-to-project.mts").filter((call) => !ofTheRepository.test(call))).toEqual([]);
  });

  it("opens no file at all in templates.mts", () => {
    expect(readFileSync(join(SCRIPTS, "lib/templates.mts"), "utf8")).not.toContain('from "node:fs"');
  });

  it("opens files in install.mts only in the functions that check the path, and the two that read this repository", () => {
    const source = readFileSync(join(SCRIPTS, "lib/install.mts"), "utf8");
    const functions = source.split(/\n(?=(?:export )?function )/).slice(1);
    const withFileCalls = functions.filter((text) => new RegExp(FS_CALL.source).test(text)).map((text) => /function (\w+)/.exec(text)?.[1]);

    expect(withFileCalls).toEqual(["listFiles", "readFileSet", "assertInside", "projectHas", "readProjectFile", "listProjectFolders", "removeProjectFile", "writeProjectFile", "replaceProjectFile"]);
  });

  it("has each of those helpers ask assertInside before it touches the disk", () => {
    const source = readFileSync(join(SCRIPTS, "lib/install.mts"), "utf8");

    for (const name of ["projectHas", "readProjectFile", "removeProjectFile", "writeProjectFile", "replaceProjectFile"]) {
      const body = source.slice(source.indexOf(`export function ${name}(`));

      expect(body.indexOf("assertInside(project, path);"), name).toBeGreaterThan(-1);
      expect(body.indexOf("assertInside(project, path);"), name).toBeLessThan(body.search(/\b(lstatSync|readFileSync|writeFileSync|mkdirSync|rmSync)\(/));
    }
  });
});

interface World {
  repository: string;
  project: string;
  root: string;
}

/** A stand-in repository with a kit, a starter of one settings file and one add-on; a project; and a secret beside them. */
function createWorld(): World {
  const root = mkdtempSync(join(tmpdir(), "project-paths-"));
  const repository = join(root, "repository");
  const project = join(root, "project");

  write(repository, "kit/gates/run.mts", "// gates\n");
  write(repository, "kit/hooks/claude.settings.json", "{}\n");
  write(repository, "kit/hooks/codex.hooks.json", "{}\n");
  write(repository, "kit/architecture.config.example.mts", "// example\n");
  write(repository, "starter/.nvmrc", "26\n");
  write(repository, "addons/demo/addon.json", JSON.stringify({ name: "demo", summary: "d", startingFiles: ["POLICY.md"] }));
  write(repository, "addons/demo/files/POLICY.md", "# Policy\n");
  write(project, "package.json", '{ "name": "p", "scripts": { "gate:fast": "x", "gate:full": "y" } }\n');
  write(project, "packages/web/package.json", '{ "name": "@acme/web" }\n');
  write(root, "secret.txt", `${SECRET}\n`);

  return { repository, project, root };
}

/** The same, with the kit in and an add-on that offers two options, each one file. */
function createWorldWithChoice(): World {
  const world = createWorld();
  const { repository, project } = world;

  addToProject({ project, unit: "kit", repository });
  write(repository, "addons/demo/addon.json", JSON.stringify({ name: "demo", summary: "d", choice: { default: "a", options: { a: "A", b: "B" } } }));
  write(repository, "addons/demo/choice/a/files/A.md", "a\n");
  write(repository, "addons/demo/choice/b/files/B.md", "b\n");

  return world;
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function replaceWithLink(project: string, path: string, target: string): void {
  mkdirSync(dirname(join(project, path)), { recursive: true });
  rmSync(join(project, path), { force: true });
  symlinkSync(target, join(project, path));
}
