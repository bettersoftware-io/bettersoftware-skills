// Decides whether a shell command joins an outward step to anything else.
//
// An outward step sends something off this machine or changes shared state:
// a push, a pull request written to, a workflow started. Each one is meant to
// be a tool call of its own, so that the permission prompt it raises names
// what is being approved and nothing else waits behind it.

import { parseShell, type Script, ShellError, type Stage } from "./shell.mts";

/** `gh <group> <action>` pairs that write. Every other pair reads. */
const GH_OUTWARD: Record<string, string[]> = {
  pr: ["create", "merge", "edit", "comment", "close", "reopen", "ready", "review"],
  issue: ["create", "comment", "edit", "close", "reopen"],
  workflow: ["run", "enable", "disable"],
  run: ["rerun", "cancel", "delete"],
  release: ["create", "delete", "edit", "upload"],
  repo: ["create", "delete", "edit", "fork"],
};
const GIT_OUTWARD = ["push"];
const WRITE_METHODS = ["POST", "PATCH", "PUT", "DELETE"];
/** `gh api` sends these as a request body, which makes the call a write unless a method says otherwise. */
const GH_API_FIELDS = ["-f", "-F", "--field", "--raw-field", "--input"];
/** `git` options that take their value as the next word. */
const GIT_OPTIONS_WITH_VALUE = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"];
/** Words a shell allows before a command that are not the command. */
const LEADING_WORDS = ["then", "do", "else", "elif", "if", "while", "until", "!", "{", "}", "time", "command", "exec", "nohup", "env"];
const SHELLS = ["bash", "sh", "zsh", "dash", "ksh"];

export interface Verdict {
  /** The outward steps found, as the first words of each. */
  outward: string[];
  /** True when an outward step shares the command with anything else. */
  chained: boolean;
}

/**
 * Judges one command line. Undefined when it cannot be read: then this has no
 * verdict, and the host's own permission rules are the only judge.
 */
export function judgeCommand(command: string): Verdict | undefined {
  try {
    return judgeScript(parseShell(command));
  } catch (error) {
    if (error instanceof ShellError) {
      return undefined;
    }

    throw error;
  }
}

function judgeScript(script: Script): Verdict {
  const outward: string[] = [];
  let chained = false;
  let steps = 0;

  for (const step of script.steps) {
    const stages = step.map(commandWords).filter((words) => words.length > 0);

    if (stages.length > 0) {
      steps += 1;
    }

    for (const words of stages) {
      if (isOutward(words)) {
        outward.push(words.slice(0, 3).join(" "));
      }

      // `bash -c "…"` and `eval "…"` run what their argument says.
      const inline = inlineScript(words);

      if (inline !== undefined) {
        const inner = judgeScript(inline);

        outward.push(...inner.outward);
        chained ||= inner.chained;
      }
    }
  }

  for (const nested of script.nested) {
    const inner = judgeScript(nested);

    outward.push(...inner.outward);
    chained ||= inner.chained;
  }

  // One outward step with a filter behind a pipe, or with a `$(cat …)` that
  // only feeds it, is still one step. Two of them, or one beside any other
  // step, is a chain.
  return { outward, chained: chained || (outward.length > 0 && (steps > 1 || outward.length > 1)) };
}

/** The command's own words: no `VAR=value` in front, no `then`, `time` or `env`. */
export function commandWords(stage: Stage): string[] {
  let words = stage;

  while (words[0] !== undefined && (LEADING_WORDS.includes(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) {
    words = words.slice(1);
  }

  return words;
}

export function isOutward(words: string[]): boolean {
  const program = (words[0] ?? "").split("/").pop();

  if (program === "git") {
    return GIT_OUTWARD.includes(skipGitOptions(words.slice(1))[0] ?? "");
  }

  if (program === "gh") {
    const rest = skipGhOptions(words.slice(1));
    const [group = "", action = ""] = rest;

    return group === "api" ? isWritingApiCall(rest) : (GH_OUTWARD[group] ?? []).includes(action);
  }

  return false;
}

/** `git -C dir -c key=value push` → `push`. */
function skipGitOptions(words: string[]): string[] {
  let rest = words;

  while (rest[0]?.startsWith("-")) {
    rest = rest.slice(GIT_OPTIONS_WITH_VALUE.includes(rest[0]) ? 2 : 1);
  }

  return rest;
}

/** `gh -R owner/name pr merge` → `pr merge`. */
function skipGhOptions(words: string[]): string[] {
  let rest = words;

  while (rest[0]?.startsWith("-")) {
    rest = rest.slice(["-R", "--repo"].includes(rest[0]) ? 2 : 1);
  }

  return rest;
}

/** The first method named decides; with none, a request body makes it a write. */
function isWritingApiCall(words: string[]): boolean {
  for (const [index, word] of words.entries()) {
    if (word === "-X" || word === "--method") {
      return WRITE_METHODS.includes((words[index + 1] ?? "").toUpperCase());
    }

    const joined = /^(?:--method=|-X)(.+)$/.exec(word)?.[1];

    if (joined !== undefined) {
      return WRITE_METHODS.includes(joined.toUpperCase());
    }
  }

  return words.some((word) => GH_API_FIELDS.includes(word) || /^(?:--field|--raw-field|--input)=/.test(word));
}

/** What `bash -c <text>` or `eval <text>` will run, when it can be read. */
function inlineScript(words: string[]): Script | undefined {
  const program = (words[0] ?? "").split("/").pop() ?? "";
  let text: string | undefined;

  if (program === "eval") {
    text = words.slice(1).join(" ");
  } else if (SHELLS.includes(program)) {
    const flag = words.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word));

    text = flag === -1 ? undefined : words[flag + 1];
  }

  if (text === undefined) {
    return undefined;
  }

  try {
    return parseShell(text);
  } catch (error) {
    if (error instanceof ShellError) {
      return undefined;
    }

    throw error;
  }
}
