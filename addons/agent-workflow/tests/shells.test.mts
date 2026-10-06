// Runs what the approving reader accepts through every shell on this machine,
// and compares the words each shell passes on with the words the reader read.
//
// The reader approves a command from its text. That is only safe for text
// every shell reads the same way, and whether a shell does is a fact about
// the shell, found by running it. An argument about what a shell "should" do
// is how the reader came to accept `"$(cat <<'EOF' … EOF )"`, which bash 3.2
// does not read the way zsh does.
//
// A shell that is not on the machine is skipped, by name. No shell at all
// fails.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

import { approvedShape, readExact, type Token } from "../files/tools/agent-workflow/lib/approve.mts";
import { APPROVED } from "./shapes.mts";
import { createFolder } from "./support.mts";

const PRINTER = join(import.meta.dirname, "print-argv.mts");

interface Shell {
  name: string;
  /** Where it is, or undefined when it is not on this machine. */
  path: string | undefined;
  version: string;
}

const SHELLS: Shell[] = [
  createShell("/bin/bash", "/bin/bash"),
  createShell("/bin/sh", "/bin/sh"),
  createShell("zsh", findOnPath("zsh")),
  createShell("dash", findOnPath("dash")),
  // Only when it is another program than /bin/bash: a newer bash, where the system's is old.
  createShell("a second bash on PATH", findOnPath("bash", "/bin/bash")),
];

/**
 * Text for the arguments of a command, each with whether the reader takes it.
 * What it takes is run through every shell; what it refuses is only shown to
 * be refused. Several hold a command that would leave a file named `canary`.
 */
const PROBES: [string, string, "read" | "refused"][] = [
  ["plain words", "push origin worktree-a", "read"],
  ["a word of one dash, of two, of three", "- -- ---", "read"],
  ["dots and slashes", ". .. / ./a ../b a/b/c a.b.c", "read"],
  ["a flag with a dash inside", "--delete-branch -n 5 -20", "read"],
  ["words with digits and underscores", "a_b 123 0x1F v1.2.3", "read"],
  ["several spaces and a tab between words", "a   b\tc  ", "read"],
  ["an empty single-quoted word and an empty double-quoted one", "'' \"\" a", "read"],
  ["a new line in single quotes", "'one\ntwo\n\nfour'", "read"],
  ["a new line in double quotes", '"one\ntwo\n\nfour"', "read"],
  ["a new line at each end of single quotes", "'\none\n'", "read"],
  ["a tab in single and in double quotes", "'a\tb' \"c\td\"", "read"],
  ["a command in single quotes", "'; touch canary ; $(touch canary) `touch canary` | touch canary & touch canary'", "read"],
  ["a command in double quotes", '"; touch canary ; | touch canary & touch canary > canary < canary"', "read"],
  ["brackets and a quote of the other kind in single quotes", "'see (link) and a ) \" ; touch canary ; \"'", "read"],
  ["brackets and a quote of the other kind in double quotes", "\"see (link) and it's a ) ' ; touch canary ; '\"", "read"],
  ["a variable and a backslash in single quotes", "'$HOME ${PATH} $0 $$ $? \\n \\\\ \\'", "read"],
  ["an exclamation mark in single quotes", "'done! !! !$ !-1 !cat'", "read"],
  ["an exclamation mark in double quotes", '"done!"', "refused"],
  ["a tilde in single and in double quotes", "'~' \"~/x\" '~root'", "read"],
  ["a tilde outside quotes", "~", "refused"],
  ["a word that starts with = in quotes", "'=ls' \"=cat\"", "read"],
  ["a word that starts with = outside quotes", "=ls", "refused"],
  ["a brace list in quotes", "'{a,b}' \"{1..3}\"", "read"],
  ["a brace list outside quotes", "{a,b}", "refused"],
  ["a glob in quotes", "'*' \"?\" '[a-z]*' \"**/*.md\"", "read"],
  ["a glob outside quotes", "*", "refused"],
  ["a hash at the start of a quoted word and inside one", "'#x' \"#y\" 'a#b' \"a # b\"", "read"],
  ["a hash at the start of a word", "#x", "refused"],
  ["a hash inside a word", "a#b", "refused"],
  ["a carriage return in quotes", "'a\rb'", "refused"],
  ["a NUL in quotes", "'a\u0000b'", "refused"],
  ["an escape character in quotes", "'a\u001b[31mb'", "refused"],
  ["a bell, a backspace, a form feed and a delete in quotes", "'\u0007' '\b' '\f' '\u007f'", "refused"],
  ["a non-breaking space in quotes", "'a b' \"c d\"", "read"],
  ["a non-breaking space between words", "a b", "refused"],
  ["other spaces that are not ASCII, in quotes", "'a b c d\u0085e　f​g﻿h'", "read"],
  ["letters that are not ASCII, and a face, in quotes", "'café über 日本 \u{1F600}' \"naïve\"", "read"],
  ["a quoted word next to a quoted word, with a space", "'a' 'b' \"c\" \"d\" 'e' \"f\"", "read"],
  ["a quoted word next to a quoted word, with no space", "'a''b'", "refused"],
  ["a quoted word joined to a bare one", "'a'b", "refused"],
  ["words that are flags of the shell or of a builtin", "'-n' '-e' \"-c\" -x --help", "read"],
  ["a percent sign and a caret in quotes", "'%s %d %%' \"a^b ^ c\" '%1'", "read"],
  ["the two marks, in quotes", "'2>&1' \"|\" '| tail -2' \"2>&1 | sh\"", "read"],
  ["words a shell gives meaning to at the start of a command", "if then else fi do done while for in case esac function time select coproc", "read"],
  ["the longest single-quoted text the reader takes", `'${"a b\n".repeat(4990)}'`, "read"],
  ["a substitution in double quotes", '"$(touch canary)"', "refused"],
  ["a heredoc in a substitution in double quotes", "\"$(cat <<'EOF'\ntext\nEOF\n)\"", "refused"],
  ["a backtick in double quotes", '"`touch canary`"', "refused"],
  ["a variable in double quotes", '"$HOME"', "refused"],
  ["a backslash in double quotes", '"a\\"b"', "refused"],
];

/** The form the reader used to take, with a body that leaves a file when a shell runs it. */
const HEREDOC_THAT_RUNS = "--body \"$(cat <<'EOF'\nsee (link) and a ) \" ; touch canary ; \"\nEOF\n)\"";

describe("the shells on this machine", () => {
  it("are at least one", () => {
    expect(SHELLS.filter((shell) => shell.path !== undefined).map((shell) => shell.name)).not.toEqual([]);
  });

});

describe("what the reader refuses", () => {
  it.each(PROBES.filter(([, , verdict]) => verdict === "refused"))("is refused: %s", (_name, text) => {
    expect(readExact(text)).toBeUndefined();
  });

  it("is the heredoc form too", () => {
    expect(readExact(HEREDOC_THAT_RUNS)).toBeUndefined();
    expect(approvedShape(`gh pr create ${HEREDOC_THAT_RUNS}`)).toBeUndefined();
  });
});

describe.each(SHELLS)("$name", ({ name, path, version }) => {
  describe.skipIf(path === undefined)(`${name} (${version})`, () => {
    const shell = path as string;

    it.each(APPROVED)("passes on the words the reader read, and runs nothing else: %s", (command) => {
      const tokens = readExact(command) as Token[];
      const mark = tokens.findIndex((token) => token.kind === "mark");
      const words = (mark === -1 ? tokens : tokens.slice(0, mark)).map((token) => token.value);
      const ran = runWithPrinter(shell, command.replace(/^\s*(?:git|gh)(?=\s|$)/, ""));

      expect(["git", "gh"]).toContain(words[0]);
      expect(ran.stderr).toBe("");
      expect(ran.status).toBe(0);
      expect(JSON.parse(ran.stdout)).toEqual(words.slice(1));
      expect(ran.left).toEqual([]);
    });

    it.each(PROBES.filter(([, , verdict]) => verdict === "read"))("passes on the words the reader read, and runs nothing else: %s", (_name, text) => {
      const tokens = readExact(text) as Token[];
      const ran = runWithPrinter(shell, ` ${text}`);

      expect(tokens.every((token) => token.kind !== "mark")).toBe(true);
      expect(ran.stderr).toBe("");
      expect(ran.status).toBe(0);
      expect(JSON.parse(ran.stdout)).toEqual(tokens.map((token) => token.value));
      expect(ran.left).toEqual([]);
    });
  });

  // The check on this test itself: with the form the reader no longer takes,
  // a shell that counts brackets runs the body. If this ever stops failing
  // for such a shell, the tests above have stopped being able to see it.
  describe.skipIf(path === undefined || !/version 3\./.test(version))(`${name} (${version}), which finds the end of a substitution by counting brackets`, () => {
    it("runs what the body of a quoted heredoc holds, which is why the reader has no token for one", () => {
      const ran = runWithPrinter(path as string, ` ${HEREDOC_THAT_RUNS}`);

      expect(ran.left).toEqual(["canary"]);
    });
  });

  describe.skipIf(path === undefined || /version 3\./.test(version))(`${name} (${version}), which reads a quoted heredoc as text`, () => {
    it("does not run the body of a quoted heredoc, so one shell agreeing proves nothing about another", () => {
      const ran = runWithPrinter(path as string, ` ${HEREDOC_THAT_RUNS}`);

      expect(ran.left).toEqual([]);
      expect(JSON.parse(ran.stdout)).toEqual(["--body", 'see (link) and a ) " ; touch canary ; "']);
    });
  });
});

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The files in the folder it ran in afterwards. Anything here was made by a command that should not have run. */
  left: string[];
}

/** Runs `<printer><rest>` in `shell`, in an empty folder, with none of the person's own shell settings. */
function runWithPrinter(shell: string, rest: string): Ran {
  const folder = createFolder();
  const home = createFolder();
  const ran = spawnSync(shell, ["-c", `'${process.execPath}' --disable-warning=ExperimentalWarning '${PRINTER}'${rest}`], {
    cwd: folder,
    encoding: "utf8",
    // An empty home: no start-up file of the person running the tests is read.
    env: { PATH: process.env.PATH, HOME: home, ZDOTDIR: home, LANG: "en_US.UTF-8" },
  });

  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr, left: readdirSync(folder) };
}

function createShell(name: string, path: string | undefined): Shell {
  const found = path !== undefined && existsSync(path) ? path : undefined;

  if (found === undefined) {
    return { name, path: undefined, version: "not on this machine" };
  }

  const asked = spawnSync(found, ["--version"], { encoding: "utf8" });
  const first = asked.status === 0 ? (asked.stdout.split("\n")[0] ?? "").trim() : "";

  // dash has no --version.
  return { name, path: found, version: first === "" ? "version not said" : first.replace(/^GNU bash, /, "").replace(/ \(.*$/, "") };
}

/** Where `program` is on PATH, unless that is the same program as `not`. */
function findOnPath(program: string, not?: string): string | undefined {
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(folder, program);

    if (folder !== "" && existsSync(candidate) && (not === undefined || !existsSync(not) || realpathSync(candidate) !== realpathSync(not))) {
      return candidate;
    }
  }

  return undefined;
}
