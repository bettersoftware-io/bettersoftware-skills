// Decides whether a shell command is exactly one of a few routine outward
// steps, written in exactly one of the forms listed here.
//
// This is an allowlist of shapes, not a list of bad spellings. A pattern such
// as `git push origin worktree-*` cannot say "one word": it also matches a
// second branch, `--delete`, `--mirror`, and whatever else nobody thought to
// forbid. So the command is read token by token with a reader that knows
// only what the shapes need, and anything it does not know is "no".
//
// The rule for what the reader may know: only text that every shell a host
// may run it with reads the same way. That is tested, not argued: the tests
// run every approved example and a set of hostile strings through each shell
// on the machine and compare the words the shell passes with the reader's.
// The reader once took `"$(cat <<'EOF' … EOF )"` for literal text. bash 3.2,
// which is /bin/bash and /bin/sh on every Mac, finds the end of `$(…)` by
// counting brackets and runs what the heredoc's body holds. So the reader
// has no token for any substitution at all.
//
// It accepts three kinds of token, each followed by a space, a tab or the end
// of the command:
//
//   bare      letters, digits and `_ . / -`, nothing else
//   'single'  any text up to the next single quote
//   "double"  text with no `$`, no backtick, no backslash and no `!`
//
// A quoted token may hold a new line and a tab, and no other control
// character. And two marks, only at the end: `2>&1` and `|` into `tail` or
// `head` with a count. A variable, a glob, a backtick, a substitution, a
// heredoc, a redirection to a file, a new line outside quotes, `&&` or `;`:
// the reader has no token for them, so the command is not approved.
//
// A shape is words. What the words would do is asked afterwards, of git and
// of GitHub, by the hook (`push.mts`, `pull-request.mts`): this file never
// leaves the text.

export type TokenKind = "bare" | "single" | "double" | "mark";

export interface Token {
  kind: TokenKind;
  /** What the shell would pass on: the text without its quotes. */
  value: string;
}

const BARE = /^[A-Za-z0-9_./-]+/;
// Control characters other than a new line and a tab are kept out of quoted
// text: nothing a pull request says needs one, and a terminal or a log that
// shows the command may not show them.
const DOUBLE = /^"([^"$`\\!\x00-\x08\x0B-\x1F\x7F]*)"/;
const SINGLE = /^'([^'\x00-\x08\x0B-\x1F\x7F]*)'/;
const MARK = /^(?:2>&1|\|)/;
/** What separates two tokens: spaces and tabs. Not a new line. */
const GAP = /^[ \t]+/;

/** One name after `worktree-`: letters and digits, joined by single `.`, `_` or `-`. */
export const WORK_BRANCH = /^worktree-[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const BASE_BRANCH = /^[A-Za-z0-9]+(?:[._/-][A-Za-z0-9]+)*$/;
const LONGEST_BRANCH = 100;
/** Longer than any real title and body together. Past it nothing is read. */
const LONGEST_COMMAND = 20_000;

/** The command as tokens, or undefined when any part of it is something the reader has no token for. */
export function readExact(command: string): Token[] | undefined {
  if (command.length > LONGEST_COMMAND) {
    return undefined;
  }

  const tokens: Token[] = [];
  let rest = command;

  for (;;) {
    rest = rest.replace(GAP, "");

    if (rest === "") {
      return tokens;
    }

    const token = readToken(rest);

    if (token === undefined) {
      return undefined;
    }

    rest = rest.slice(token.length);

    // A token ends at a gap or at the end: `a"b"` and `'x'y` are not tokens.
    if (rest !== "" && !GAP.test(rest)) {
      return undefined;
    }

    tokens.push({ kind: token.kind, value: token.value });
  }
}

function readToken(text: string): (Token & { length: number }) | undefined {
  for (const [kind, pattern] of [
    ["mark", MARK],
    ["single", SINGLE],
    ["double", DOUBLE],
    ["bare", BARE],
  ] as const) {
    const match = pattern.exec(text);

    if (match !== null) {
      return { kind, value: match[1] ?? match[0], length: match[0].length };
    }
  }

  return undefined;
}

/** One of the three steps, with the parts of it that are checked against the repository afterwards. */
export type Shape =
  | { step: "push"; branch: string; says: string }
  | { step: "create"; head: string; says: string }
  | { step: "merge"; number: string; commit: string; says: string };

/** What is approved, in words, or undefined when the command is not one of the shapes. */
export function approvedShape(command: string): string | undefined {
  return readShape(command)?.says;
}

/** The step a command is, or undefined when the command is not one of the shapes. */
export function readShape(command: string): Shape | undefined {
  const tokens = readExact(command);

  if (tokens === undefined) {
    return undefined;
  }

  const firstMark = tokens.findIndex((token) => token.kind === "mark");
  const step = firstMark === -1 ? tokens : tokens.slice(0, firstMark);

  if (firstMark !== -1 && !isOutputFilter(tokens.slice(firstMark))) {
    return undefined;
  }

  return [pushOfWorkBranch, pullRequestCreation, pullRequestMerge].map((shape) => shape(step)).find((name) => name !== undefined);
}

/** `2>&1`, `| tail -2`, or the first then the second. Nothing else may follow the step. */
function isOutputFilter(tokens: Token[]): boolean {
  const rest = tokens[0]?.value === "2>&1" ? tokens.slice(1) : tokens;

  if (rest.length === 0) {
    return true;
  }

  const [pipe, program, ...count] = rest;

  return (
    pipe?.kind === "mark" &&
    pipe.value === "|" &&
    program?.kind === "bare" &&
    ["tail", "head"].includes(program.value) &&
    count.every((token) => token.kind === "bare") &&
    /^(?:-n \d+|-\d+)$/.test(count.map((token) => token.value).join(" "))
  );
}

/** `git push [-u | --set-upstream] origin worktree-<name>`: those words and no other. */
function pushOfWorkBranch(tokens: Token[]): Shape | undefined {
  if (tokens.some((token) => token.kind !== "bare")) {
    return undefined;
  }

  const words = tokens.map((token) => token.value);
  const upstream = words[2] === "-u" || words[2] === "--set-upstream" ? 1 : 0;
  const branch = words[3 + upstream] ?? "";

  return words.length === 4 + upstream &&
    words[0] === "git" &&
    words[1] === "push" &&
    words[2 + upstream] === "origin" &&
    branch.length <= LONGEST_BRANCH &&
    WORK_BRANCH.test(branch)
    ? { step: "push", branch, says: `a push of the work branch ${branch} to origin` }
    : undefined;
}

interface Flag {
  /** The long name; the key two spellings of one flag share. */
  name: string;
  /** What the next token must be, for a flag that takes a value. */
  value?: (token: Token) => boolean;
}

const isWorkBranch = (token: Token): boolean => token.kind === "bare" && token.value.length <= LONGEST_BRANCH && WORK_BRANCH.test(token.value);
/** A whole commit name: forty hexadecimal digits, as `git rev-parse` prints them. */
const isCommit = (token: Token): boolean => token.kind === "bare" && /^[0-9a-f]{40}$/.test(token.value);
const isText = (token: Token): boolean => token.kind === "single" || token.kind === "double" || token.kind === "bare";

// Left out on purpose. `--body-file` and `--template` post the content of any
// file this machine can read. `--repo` aims the call at another repository.
// `--web` and `--editor` wait for a person. `--reviewer`, `--assignee`,
// `--label`, `--milestone` and `--project` notify or change other things.
//
// `--head` is required. Without it `gh` works out the branch itself, and
// pushes it when it is not on GitHub yet: a second push, to a remote of its
// own choosing, that no check here would have seen.
const CREATE_FLAGS: Record<string, Flag> = {
  "--title": { name: "--title", value: isText },
  "-t": { name: "--title", value: isText },
  "--body": { name: "--body", value: isText },
  "-b": { name: "--body", value: isText },
  "--base": { name: "--base", value: (token) => token.kind === "bare" && BASE_BRANCH.test(token.value) },
  "-B": { name: "--base", value: (token) => token.kind === "bare" && BASE_BRANCH.test(token.value) },
  "--head": { name: "--head", value: isWorkBranch },
  "-H": { name: "--head", value: isWorkBranch },
  "--draft": { name: "--draft" },
  "-d": { name: "--draft" },
  "--fill": { name: "--fill" },
  "-f": { name: "--fill" },
};

// The three ways to merge are the project's convention, not a matter of
// safety, so each is approved, one at a time. Left out on purpose: `--admin`
// merges past the branch's protections; `--repo` aims at another repository;
// `--auto` and `--disable-auto` move the merge to a later time when nobody is
// looking at what was pushed since; `--body-file` posts any file;
// `--delete-branch` also changes this checkout (it switches branch and
// pulls), which runs the repository's own hooks and filters.
//
// `--match-head-commit` is required. GitHub then merges that commit or
// nothing, so what the hook checked is what is merged, whatever is pushed to
// the branch in between.
const MERGE_FLAGS: Record<string, Flag> = {
  "--merge": { name: "method" },
  "-m": { name: "method" },
  "--squash": { name: "method" },
  "-s": { name: "method" },
  "--rebase": { name: "method" },
  "-r": { name: "method" },
  "--match-head-commit": { name: "--match-head-commit", value: isCommit },
  "--subject": { name: "--subject", value: isText },
  "-t": { name: "--subject", value: isText },
  "--body": { name: "--body", value: isText },
  "-b": { name: "--body", value: isText },
};

/** `gh pr create` with flags from the table, each at most once, `--head` among them. */
function pullRequestCreation(tokens: Token[]): Shape | undefined {
  const head = startsWith(tokens, ["gh", "pr", "create"]) ? readFlags(tokens.slice(3), CREATE_FLAGS)?.get("--head") : undefined;

  return head === undefined ? undefined : { step: "create", head, says: "opening a pull request" };
}

/** `gh pr merge <number>` with flags from the table, each at most once, `--match-head-commit` among them. */
function pullRequestMerge(tokens: Token[]): Shape | undefined {
  const number = tokens[3];
  const commit =
    startsWith(tokens, ["gh", "pr", "merge"]) && number?.kind === "bare" && /^[1-9]\d*$/.test(number.value)
      ? readFlags(tokens.slice(4), MERGE_FLAGS)?.get("--match-head-commit")
      : undefined;

  return number === undefined || commit === undefined ? undefined : { step: "merge", number: number.value, commit, says: `merging pull request ${number.value}` };
}

function startsWith(tokens: Token[], words: string[]): boolean {
  return words.every((word, index) => tokens[index]?.kind === "bare" && tokens[index]?.value === word);
}

/** The flags given, by long name, each with its value ("" for a flag that takes none). Undefined when anything is not a flag of the table. */
function readFlags(tokens: Token[], flags: Record<string, Flag>): Map<string, string> | undefined {
  const seen = new Map<string, string>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    // `hasOwn`: a word such as `constructor` is on every object, and is not a flag.
    const flag = token.kind === "bare" && Object.hasOwn(flags, token.value) ? flags[token.value] : undefined;

    if (flag === undefined || seen.has(flag.name)) {
      return undefined;
    }

    seen.set(flag.name, "");

    if (flag.value !== undefined) {
      index += 1;

      const value = tokens[index];

      if (value === undefined || !flag.value(value)) {
        return undefined;
      }

      seen.set(flag.name, value.value);
    }
  }

  return seen;
}
