// Reads a shell command line far enough to answer one question: which
// commands does it run, and how are they joined?
//
// It is not a shell. It knows quoting, heredocs, redirections, pipes, the
// separators (`&&`, `||`, `;`, `&`, a newline), grouping and command
// substitution. It expands nothing: `$branch` stays the text `$branch`.
//
// A command it cannot read (a quote that never closes) throws `ShellError`.
// The caller decides what that means.

export class ShellError extends Error {}

/** One command of a pipeline: its words, with quotes removed and redirections dropped. */
export type Stage = string[];

/** Commands joined by `|`. Whatever joins two steps (`&&`, `;`, a newline) ends one. */
export type Step = Stage[];

export interface Script {
  steps: Step[];
  /** What runs inside `$(…)`, backticks and `<(…)` anywhere in this script. */
  nested: Script[];
}

interface Heredoc {
  delimiter: string;
  /** `<<-`: leading tabs do not count. */
  stripTabs: boolean;
}

const WORD_END = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);

export function parseShell(text: string): Script {
  return new Scanner(text).script(undefined);
}

class Scanner {
  private readonly text: string;
  private position = 0;
  private readonly heredocs: Heredoc[] = [];

  constructor(text: string) {
    this.text = text;
  }

  /** Reads commands up to `closer`, or to the end when there is none. */
  script(closer: ")" | "`" | undefined): Script {
    const script: Script = { steps: [], nested: [] };
    let step: Step = [];
    let stage: Stage = [];
    let groups = 0;

    const endStage = (): void => {
      if (stage.length > 0) {
        step.push(stage);
      }

      stage = [];
    };
    const endStep = (): void => {
      endStage();

      if (step.length > 0) {
        script.steps.push(step);
      }

      step = [];
    };

    for (;;) {
      const char = this.text[this.position];

      if (char === undefined) {
        if (closer !== undefined) {
          throw new ShellError(`"${closer}" is never closed`);
        }

        break;
      }

      if (char === " " || char === "\t") {
        this.position += 1;
      } else if (char === "\\" && this.text[this.position + 1] === "\n") {
        this.position += 2;
      } else if (char === "\n") {
        this.position += 1;
        this.skipHeredocBodies();
        endStep();
      } else if (char === "#") {
        // Only reached where a word would start, which is where a comment may.
        this.skipLine();
      } else if (char === ";") {
        this.position += 1;
        endStep();
      } else if (char === "&") {
        if (this.text[this.position + 1] === ">") {
          this.redirection(script, closer);
        } else {
          this.position += this.text[this.position + 1] === "&" ? 2 : 1;
          endStep();
        }
      } else if (char === "|") {
        if (this.text[this.position + 1] === "|") {
          this.position += 2;
          endStep();
        } else {
          this.position += this.text[this.position + 1] === "&" ? 2 : 1;
          endStage();
        }
      } else if (char === "<" || char === ">") {
        this.redirection(script, closer);
      } else if (char === "(") {
        // A subshell runs what is inside it: the brackets change nothing here.
        this.position += 1;
        groups += 1;
      } else if (char === ")") {
        if (groups === 0 && closer === ")") {
          this.position += 1;
          break;
        }

        this.position += 1;
        groups = Math.max(0, groups - 1);
      } else if (char === "`" && closer === "`") {
        this.position += 1;
        break;
      } else {
        const word = this.word(script, closer);

        // `2>file`: the digits name a file descriptor, they are not a word.
        if (/^\d+$/.test(word) && (this.text[this.position] === "<" || this.text[this.position] === ">")) {
          continue;
        }

        stage.push(word);
      }
    }

    endStep();

    return script;
  }

  /** Reads one word, with its quotes removed. Substitutions inside it go to `script.nested`. */
  private word(script: Script, closer: ")" | "`" | undefined): string {
    let value = "";

    for (;;) {
      const char = this.text[this.position];

      if (char === undefined || WORD_END.has(char) || (char === "`" && closer === "`")) {
        return value;
      }

      if (char === "'") {
        const end = this.text.indexOf("'", this.position + 1);

        if (end === -1) {
          throw new ShellError("a single quote is never closed");
        }

        value += this.text.slice(this.position + 1, end);
        this.position = end + 1;
      } else if (char === '"') {
        this.position += 1;
        value += this.doubleQuoted(script);
      } else if (char === "\\") {
        const next = this.text[this.position + 1];

        value += next === undefined || next === "\n" ? "" : next;
        this.position += 2;
      } else if (char === "$" && this.text[this.position + 1] === "(") {
        this.position += 2;
        script.nested.push(this.script(")"));
        value += "$(…)";
      } else if (char === "$" && this.text[this.position + 1] === "{") {
        const end = this.text.indexOf("}", this.position);

        if (end === -1) {
          throw new ShellError('"${" is never closed');
        }

        value += this.text.slice(this.position, end + 1);
        this.position = end + 1;
      } else if (char === "$" && this.text[this.position + 1] === "'") {
        const end = this.text.indexOf("'", this.position + 2);

        if (end === -1) {
          throw new ShellError("a single quote is never closed");
        }

        value += this.text.slice(this.position + 2, end);
        this.position = end + 1;
      } else if (char === "`") {
        this.position += 1;
        script.nested.push(this.script("`"));
        value += "`…`";
      } else {
        value += char;
        this.position += 1;
      }
    }
  }

  /** Reads to the closing double quote; the opening one is already behind. */
  private doubleQuoted(script: Script): string {
    let value = "";

    for (;;) {
      const char = this.text[this.position];

      if (char === undefined) {
        throw new ShellError("a double quote is never closed");
      }

      if (char === '"') {
        this.position += 1;

        return value;
      }

      if (char === "\\") {
        const next = this.text[this.position + 1] ?? "";

        // Inside double quotes a backslash only escapes these.
        value += ['"', "\\", "$", "`"].includes(next) ? next : next === "\n" ? "" : `\\${next}`;
        this.position += 2;
      } else if (char === "$" && this.text[this.position + 1] === "(") {
        this.position += 2;
        script.nested.push(this.script(")"));
        value += "$(…)";
      } else if (char === "`") {
        this.position += 1;
        script.nested.push(this.script("`"));
        value += "`…`";
      } else {
        if (char === "\n") {
          // A heredoc opened inside `"$(…)"` has its body here.
          this.position += 1;
          this.skipHeredocBodies();
          value += "\n";
          continue;
        }

        value += char;
        this.position += 1;
      }
    }
  }

  /** Reads a redirection and what it points at. Neither is a word of the command. */
  private redirection(script: Script, closer: ")" | "`" | undefined): void {
    const operator = /^(?:&>>?|<<<|<<-?|<&|<>|<\(|>\(|>>|>&|>\||<|>)/.exec(this.text.slice(this.position))?.[0] ?? "";

    this.position += operator.length;

    if (operator === "<(" || operator === ">(") {
      script.nested.push(this.script(")"));

      return;
    }

    while (this.text[this.position] === " " || this.text[this.position] === "\t") {
      this.position += 1;
    }

    const target = this.word(script, closer);

    if (operator === "<<" || operator === "<<-") {
      this.heredocs.push({ delimiter: target, stripTabs: operator === "<<-" });
    }
  }

  /** Called just after a newline: drops the body of every heredoc opened on the line before. */
  private skipHeredocBodies(): void {
    for (const { delimiter, stripTabs } of this.heredocs.splice(0)) {
      for (;;) {
        if (this.position >= this.text.length) {
          throw new ShellError(`the heredoc "${delimiter}" is never closed`);
        }

        const end = this.text.indexOf("\n", this.position);
        const line = this.text.slice(this.position, end === -1 ? this.text.length : end);

        this.position = end === -1 ? this.text.length : end + 1;

        if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) {
          break;
        }
      }
    }
  }

  private skipLine(): void {
    const end = this.text.indexOf("\n", this.position);

    this.position = end === -1 ? this.text.length : end;
  }
}
