// Finds the comments that take code out of the measurement without saying why.
//
// A comment such as `/* v8 ignore next */` removes lines from the numbers, so
// a file can meet the bar with code no test reaches. That is sometimes right
// (a line only a real browser runs), and then the comment says so:
//
//   /* v8 ignore next 3 -- only a real browser reports a width of 0 */
//
// The reason comes after ` -- `. A comment without one fails the gate.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface IgnoreComment {
  /** Path from the project root. */
  file: string;
  line: number;
}

// `stop` ends a range whose `start` carries the reason, so it needs none.
const IGNORE = /(?:\/\*|\/\/)\s*(?:v8|c8|istanbul)\s+ignore\s+(?!stop\b)(.*)$/;
const REASON = /\s--\s+\S/;

/** Every ignore comment in `files` (paths from `root`) that gives no reason. */
export function findUnexplainedIgnores(root: string, files: string[]): IgnoreComment[] {
  return files.flatMap((file) => {
    const path = join(root, file);

    if (!existsSync(path)) {
      return [];
    }

    return readFileSync(path, "utf8")
      .split("\n")
      .map((text, index) => ({ file, line: index + 1, comment: IGNORE.exec(text)?.[1] }))
      .filter(({ comment }) => comment !== undefined && !REASON.test(` ${comment.replace(/\*\/.*$/, "")}`))
      .map(({ line }) => ({ file, line }));
  });
}
