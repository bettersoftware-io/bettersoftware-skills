// Decides whether a shell command is exactly one of a few routine outward
// steps, written in exactly one of the forms listed here.
//
// This is an allowlist of shapes, not a list of bad spellings. A pattern such
// as `git push origin worktree-*` cannot say "one word": it also matches a
// second branch, `--delete`, `--mirror`, and whatever else nobody thought to
// forbid. So the command is read token by token with a reader that knows
// only what the shapes need, and anything it does not know is "no".
//
// The reader accepts four kinds of token, each followed by a space or the
// end of the command:
//
//   bare      letters, digits and `_ . / -`, nothing else
//   'single'  any text up to the next single quote: the shell changes none of it
//   "double"  text with no `$`, no backtick and no backslash, so nothing in
//             it is expanded
//   heredoc   exactly `"$(cat <<'DELIM' … DELIM )"`, with the delimiter in
//             single quotes, so the body is taken as it is written
//
// and two marks, only at the end: `2>&1` and `|` into `tail` or `head` with a
// count. A variable, a glob, a backtick, any other substitution, a
// redirection to a file, a new line outside quotes, `&&` or `;`: the reader
// has no token for them, so the command is not approved.

export type TokenKind = "bare" | "single" | "double" | "heredoc" | "mark";

export interface Token {
  kind: TokenKind;
  /** What the shell would pass on: the text without its quotes. */
  value: string;
}

const BARE = /^[A-Za-z0-9_./-]+/;
const DOUBLE = /^"([^"$`\\]*)"/;
const SINGLE = /^'([^']*)'/;
const HEREDOC_OPEN = /^"\$\(cat <<'([A-Za-z_][A-Za-z0-9_]*)'\n/;
const MARK = /^(?:2>&1|\|)/;
/** What separates two tokens: spaces and tabs. Not a new line. */
const GAP = /^[ \t]+/;

/** One name after `worktree-`: letters and digits, joined by single `.`, `_` or `-`. */
const WORK_BRANCH = /^worktree-[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const BASE_BRANCH = /^[A-Za-z0-9]+(?:[._/-][A-Za-z0-9]+)*$/;
const LONGEST_BRANCH = 100;

/** The command as tokens, or undefined when any part of it is something the reader has no token for. */
export function readExact(command: string): Token[] | undefined {
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
  const heredoc = HEREDOC_OPEN.exec(text);

  if (heredoc !== null) {
    const lines = text.slice(heredoc[0].length).split("\n");
    // The first line that is the delimiter ends the body, as it does for the shell.
    const last = lines.indexOf(heredoc[1] as string);
    const body = lines.slice(0, last).join("\n");
    const close = ')"';

    // What comes straight after that line must close the whole form.
    if (last === -1 || !lines.slice(last + 1).join("\n").startsWith(close)) {
      return undefined;
    }

    return { kind: "heredoc", value: body, length: heredoc[0].length + lines.slice(0, last + 1).join("\n").length + 1 + close.length };
  }

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

/** What is approved, in words, or undefined when the command is not one of the shapes. */
export function approvedShape(command: string): string | undefined {
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
function pushOfWorkBranch(tokens: Token[]): string | undefined {
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
    ? `a push of the work branch ${branch} to origin`
    : undefined;
}

interface Flag {
  /** The long name; the key two spellings of one flag share. */
  name: string;
  /** What the next token must be, for a flag that takes a value. */
  value?: (token: Token) => boolean;
}

const isText = (token: Token): boolean => token.kind === "single" || token.kind === "double" || token.kind === "bare";
const isBody = (token: Token): boolean => isText(token) || token.kind === "heredoc";

// Left out on purpose. `--body-file` and `--template` post the content of any
// file this machine can read. `--repo` aims the call at another repository.
// `--web` and `--editor` wait for a person. `--reviewer`, `--assignee`,
// `--label`, `--milestone` and `--project` notify or change other things.
const CREATE_FLAGS: Record<string, Flag> = {
  "--title": { name: "--title", value: isText },
  "-t": { name: "--title", value: isText },
  "--body": { name: "--body", value: isBody },
  "-b": { name: "--body", value: isBody },
  "--base": { name: "--base", value: (token) => token.kind === "bare" && BASE_BRANCH.test(token.value) },
  "-B": { name: "--base", value: (token) => token.kind === "bare" && BASE_BRANCH.test(token.value) },
  "--head": { name: "--head", value: (token) => token.kind === "bare" && WORK_BRANCH.test(token.value) },
  "-H": { name: "--head", value: (token) => token.kind === "bare" && WORK_BRANCH.test(token.value) },
  "--draft": { name: "--draft" },
  "-d": { name: "--draft" },
  "--fill": { name: "--fill" },
  "-f": { name: "--fill" },
};

// The three ways to merge are the project's convention, not a matter of
// safety, so each is approved, one at a time. Left out on purpose: `--admin`
// merges past the branch's protections; `--repo` aims at another repository;
// `--auto` and `--disable-auto` move the merge to a later time when nobody is
// looking at what was pushed since; `--body-file` posts any file.
const MERGE_FLAGS: Record<string, Flag> = {
  "--merge": { name: "method" },
  "-m": { name: "method" },
  "--squash": { name: "method" },
  "-s": { name: "method" },
  "--rebase": { name: "method" },
  "-r": { name: "method" },
  "--delete-branch": { name: "--delete-branch" },
  "-d": { name: "--delete-branch" },
  "--subject": { name: "--subject", value: isText },
  "-t": { name: "--subject", value: isText },
  "--body": { name: "--body", value: isBody },
  "-b": { name: "--body", value: isBody },
};

/** `gh pr create` with flags from the table, each at most once. */
function pullRequestCreation(tokens: Token[]): string | undefined {
  return startsWith(tokens, ["gh", "pr", "create"]) && hasOnlyFlags(tokens.slice(3), CREATE_FLAGS) ? "opening a pull request" : undefined;
}

/** `gh pr merge <number>` with flags from the table, each at most once. */
function pullRequestMerge(tokens: Token[]): string | undefined {
  const number = tokens[3];

  return startsWith(tokens, ["gh", "pr", "merge"]) &&
    number?.kind === "bare" &&
    /^[1-9]\d*$/.test(number.value) &&
    hasOnlyFlags(tokens.slice(4), MERGE_FLAGS)
    ? `merging pull request ${number.value}`
    : undefined;
}

function startsWith(tokens: Token[], words: string[]): boolean {
  return words.every((word, index) => tokens[index]?.kind === "bare" && tokens[index]?.value === word);
}

function hasOnlyFlags(tokens: Token[], flags: Record<string, Flag>): boolean {
  const seen = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    // `hasOwn`: a word such as `constructor` is on every object, and is not a flag.
    const flag = token.kind === "bare" && Object.hasOwn(flags, token.value) ? flags[token.value] : undefined;

    if (flag === undefined || seen.has(flag.name)) {
      return false;
    }

    seen.add(flag.name);

    if (flag.value !== undefined) {
      index += 1;

      const value = tokens[index];

      if (value === undefined || !flag.value(value)) {
        return false;
      }
    }
  }

  return true;
}
