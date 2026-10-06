## Formatting and lint (Biome)

`pnpm biome:check` (part of `gate:fast`) fails a file that is not formatted, an
import list that is out of order, and a lint finding, warnings included. It
changes nothing. What it cannot decide is below.

**When to run the fixer.** Run `pnpm fix` after you finish editing and before
you run the gate. Do not lay code out by hand, and do not sort imports by
hand. Skip it when you changed no source, JSON or CSS file.

`pnpm fix` runs Biome's fixer and `eslint --fix` in turn until neither
changes a file. Run that one command, not the two by hand: each can make
work for the other (Biome rewraps a line, and ESLint then wants a blank line
beside it), so one pass of each is not always enough. `pnpm biome:fix` is
Biome alone.

- **It prints `FAIL fix — … still has findings no fixer repairs`.** The files
  are settled; what is listed is yours to fix in the code.
- **It prints `FAIL fix — not settled`.** The two fixers undo each other on
  the files it names. Do not run it again. That is a conflict between
  `biome.json` and the ESLint config: say so, with the file, and ask.

**An import for its effect is sorted too.** `import "./index.css"` goes
where the fixer puts it, after the code's imports. Do not write CSS that
depends on which of two imported stylesheets loads first. If one must follow
another, `@import` it from that one.

**What the fixer leaves to you.** It applies only the fixes Biome calls safe.
A finding it prints and does not fix is yours to fix in the code: add the
braces, write the type, narrow the value. Do not pass `--unsafe` over the
whole project; an unsafe fix can change what the code does.

**When a rule seems wrong.** Decide which of these it is:

- The code can say the same thing in a way the rule accepts. Do that. For a
  `!` assertion, check the value and throw with a message that says what was
  missing.
- The rule does not fit one kind of file (a framework needs a default export
  there, say). Add an `overrides` entry for those files to `biome.json` at
  the root, and write the reason in the commit message.
- The rule does not fit this project at all. Say so and ask before you turn it
  off in `biome.json`.
- One line is a true exception. Only then write
  `// biome-ignore lint/<group>/<rule>: <reason>` on the line above. The
  reason says why this line is different, not what the rule is. Never write
  one without a reason, and never to get a gate to pass.

Do not edit `tools/format-lint/biome.base.json`: an update of the add-on
replaces it. The project's own rules go in `biome.json`, which extends it.

Biome does not read `tools/`. It does not replace `pnpm lint` (ESLint, the
architecture rules); both run.
