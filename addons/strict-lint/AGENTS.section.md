## Strict lint (types and dead code)

Two checks run in `gate:fast`. `pnpm lint:types` runs the ESLint rules that
need types. `pnpm lint:dead` runs knip: unused files, exports and
dependencies. Each names the file. What they cannot decide is below.

**A promise nothing waits for.** Choose one, in this order:

- `await` it, when the code after it needs the work to be done or must see it
  fail.
- `return` it, when the caller is the one who should wait.
- Mark it `void`, when nothing may wait (an event handler, a fire-and-forget
  log). Then the promise must handle its own failure (`.catch`), and a comment
  on the line above says why nothing waits. Never write `void` to get the
  gate to pass.

**An `async` function where a plain callback is expected** (`forEach`, an
event handler, a subscriber). Do not make the callback `async`. Use a
`for…of` loop with `await`, or call a named function and treat its promise as
above.

**A `switch` that misses a case.** Add the case. Add a `default` branch only
when the rest really are handled the same way; a `default` that hides a new
member is the bug this rule exists to stop.

**"No tsconfig.json includes this file."** The file is not typechecked
either. Add it to the `include` of its package's `tsconfig.json`. Do not move
it under `tools/` to hide it.

**knip calls something unused.** First check that it is: search for the name.

- It is unused. Remove it: the file, the `export` keyword, the line in an
  `index.ts`, the line in `package.json`. Do not keep an export for a caller
  that does not exist yet; add it with the caller.
- Only a test uses it. That counts as used, and knip does not report it. If it
  is reported, the test does not import it.
- It is used in a way knip cannot follow: a file a tool loads by name, a
  program started from a string, a page a config serves. Name the file as an
  `entry` in `tools/strict-lint/knip.jsonc`, or the dependency in
  `ignoreDependencies`, with a comment that says who uses it.

Never turn a kind of finding off, and never add a file to `ignore`, to get
past one finding.

A new package needs nothing: `packages/*` covers it. Skip all of this for a
change that touches no TypeScript file and no `package.json`.

Do not edit `tools/strict-lint/eslint.typed.base.mts`; an update replaces it.
A rule the project adds or changes goes in `tools/strict-lint/eslint.config.mts`.
