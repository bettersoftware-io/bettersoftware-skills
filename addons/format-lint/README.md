# Add-on: format and lint (Biome)

Gives a project [Biome](https://biomejs.dev): one formatter, a general linter
and an import sorter, with one check in `gate:fast`. The kit's ESLint rules
stay; they judge architecture, and Biome judges everything else.

```bash
node scripts/add-to-project.mts <project> format-lint
cd <project> && pnpm install && pnpm biome:check
```

## What it adds

| Part | Where | What it does |
|---|---|---|
| Base config | `tools/format-lint/biome.base.json` | Every setting and rule below. Belongs to the add-on: an update replaces it |
| Root config | `biome.json` | Only `extends` the base. A starting file: written once, then the project's own. A project adds, changes or switches off rules here |
| `pnpm biome:check` | `biome ci --error-on-warnings .` | Fails on an unformatted file, unsorted imports, a lint error or a lint warning. Writes nothing. Joins `gate:fast`, and is the `verify` command |
| `pnpm biome:fix` | `biome check --write .` | Formats, sorts imports, applies the fixes Biome calls safe |
| `pnpm biome:format` | `biome format --write .` | Formats only |
| AGENTS section | `AGENTS.md` | When to run the fixer, and what to do when a rule seems wrong |

One dev dependency in the root `package.json`: `@biomejs/biome`, exactly
`2.5.14`. No JavaScript file, no tool of its own, no workflow: the check runs
in the project's existing CI job through `gate:full`.

The scripts are named `biome:*` because the starter already has a `lint`
script (ESLint), and an add-on may not replace a script the project has.

### Two layers

Biome resolves `extends` from the folder of the file that names it, and the
globs in the base (`!tools`, `**/dist`) from the project root, not from
`tools/format-lint/`. A setting in the root file wins over the base. All three
are tested: a rule the root switches off stops failing, a rule the root adds
fails beside the base's, and `tools/` at the root is left alone while
`packages/app/tools/` is judged.

The installer rewrites `@app/` to the project's scope in `.json` files, so the
import group `@app/**` in the base becomes `@acme/**` in the project.

## Settings and rules, with the reason for each

The source is the Biome config of ReactiveTraderCloudClone. What was kept:

**Formatter**

| Setting | Reason |
|---|---|
| Spaces, width 2, `lf` line endings | One layout, so a diff shows only what changed |
| Double quotes, a semicolon after every statement, trailing commas everywhere | The same. A trailing comma keeps a one-item addition to a one-line diff |
| Line width **80**, as in the source | Two files side by side on a laptop, and GitHub's side-by-side diff without scrolling. The cost is more wrapping, since the rules here ask for an explicit type on every parameter and return. 100 was tried for a day and taken back for the diff view |
| JSON and CSS are formatted, CSS is linted | Same rule for every file a person edits |
| `tsconfig*.json` may hold comments and trailing commas | TypeScript reads them that way, and the starter's tsconfig files have comments |

**Imports** (`organizeImports`)

Groups, in order, a blank line between each: Node built-ins, third-party
packages, the workspace's own packages (`@app/**`), aliases, relative paths
(without styles), styles. Earlier groups win, so the workspace's packages are
taken out of the third-party group by a negation; that puts `react` before
`@app/*`. Inside a group Biome sorts by distance (`../` before `./`), then by
name.

**Lint**

| Rule | Level | Reason |
|---|---|---|
| `preset: recommended` | as shipped | Biome's own set |
| `react` and `test` domains | recommended | The hook rules, `key` rules, focused tests, exports in tests. Set by name so they do not depend on what Biome finds in a `package.json` |
| `style/noNonNullAssertion` | error | `!` switches the type checker off without a trace. Check the value and throw instead. Shipped as a warning |
| `style/useImportType`, `style/useExportType` | error | A statement that names only types is spelled `import type`. The starter sets `verbatimModuleSyntax`, where `import { type A }` stays behind as a runtime import of the module |
| `style/useBlockStatements` | error | Every branch body is a block: a second statement is a one-line diff, and there is no dangling `else` |
| `style/noDefaultExport` | error | A default export has no name of its own, so each importer picks one, and an editor cannot find it. Off for `**/*.config.*` and `**/*.d.ts`, where the tool that reads the file requires one |
| `style/useComponentExportOnlyModules` | error | Fast Refresh works only for a module that exports nothing but components. Off in test code (see below) |
| `correctness/useUniqueElementIds` | error | A literal `id` in a component is repeated when the component is rendered twice. Use `useId` |
| `correctness/useImportExtensions` | error | The starter's server is run by Node from source, and Node resolves no import without its extension. Vitest resolves either form, so nothing else would catch a stray |
| `suspicious/noLeakedRender` | error | `{count && <b/>}` renders `0` |
| `suspicious/noUndeclaredEnvVars` | error | Turbo strips an environment variable that `turbo.json` does not declare, and does not cache on it. The code then reads `undefined` with no error |
| `nursery/useExplicitType` | error | Return types, parameters and variables whose type is not plain from the value are written out. The only nursery rule: its behaviour may change on a Biome update, so read the release notes then |
| `--error-on-warnings` on the check | | Plain `biome ci` exits 0 on warnings, so they pile up unseen |

## What was left out, and why

| In the source | Why it is not here |
|---|---|
| `style/noRestrictedImports` on `../../**` | The source pairs it with a `#/` import alias. The starter has no alias, and has three honest `../../` imports (two `vitest.config.ts` reach `tools/arch/testing`, one contract reaches `entities/`). Adding it means adding an alias to every package first |
| `sortBareImports` | It moves `import "./a.css"` lines. The order of imports that are there for their effect is behaviour (the cascade), and the visual add-on's host loads two stylesheets in a set order. With it off Biome never moves such a line (tested) |
| `playwright`, `project`, `turborepo`, `types` domains | Measured on 2.5.14 with a file that breaks their rules (a floating promise, `indexOf(…) === 0`, `page.waitForTimeout`, `page.pause`, a missing `await`): nothing was reported with them on, at any level. `turborepo` has one rule, which is set by name above. `project`'s rule (`noPrivateImports`) was not tried with a violation |
| `useImportExtensions` with `forceJsExtensions` for four packages | That is for libraries compiled by `tsc`. The starter compiles nothing, so the rule is on everywhere and the extension is `.ts` |
| Exclusions for `docs/design`, `docs/showcase`, `docs/presentations`, `*.json5`, `*.png`, `__screenshots__`, `pnpm-lock.yaml` | The first four are that repository's own. Biome does not read images or YAML, and the checks pass with PNG goldens and the lockfile present |
| Default exports allowed in `cucumber.mts`, `.dependency-cruiser.mts`, Expo routes | The starter has none of them |
| The three a11y and CSS overrides for one chart and one stylesheet | They are exceptions for that repository's files |
| The source's `lint` and `check` scripts | `biome:check` does what both do, and the name `lint` is taken |

Added here, not in the source:

- `tools/`, `.claude/` and `.codex/` are not read. They hold installed copies
  (the kit, the add-ons' tools, the hosts' settings); the project does not
  edit them, and the kit's settings files are not in Biome's layout.
- `style/useComponentExportOnlyModules` is off in `*.test.tsx`, `*.spec.tsx`,
  `*.page.tsx`, `tests/`, `__tests__/` and `page-objects/`. A page object
  keeps a small private component beside its `mount` function, and test code
  is never hot-reloaded.

## What changed in the starter and the other add-ons

So that a new project passes with no manual step, the starter was run through
`pnpm biome:fix` and the rest was fixed by hand. `pnpm gate:full` passes in
`starter/` afterwards (57 tests, as before).

- Imports and exports reordered in 25 files: third-party before `@app/*`, and
  type exports before value exports in the `index.ts` files. `turbo.json`
  arrays on one line; one JSX expression laid out over lines.
- A type written on seven callback parameters and one `const` (`useExplicitType`).
- `priceSimulator.ts`: a `!` removed. The starter does not set
  `noUncheckedIndexedAccess`, so it changed no type.
- `priceSimulator.contract.test.ts`: `queued.shift()!` became a `takeNext`
  helper that throws if the queue is empty. That case never happens in the
  contract; before, it would have passed `undefined` on.

The visual add-on's four TypeScript files under `packages/client-react/tests/visual/`
were formatted the same way. Two changes there are not layout:
`scenarios` is now `const scenarios: Record<string, Scenario> = {…}` instead
of `{…} satisfies Record<…>`, and `goldens.ts` has one
`biome-ignore lint/suspicious/noUndeclaredEnvVars` with its reason
(`VISUAL_GOLDENS_DIR` is read under Playwright, not under a turbo task). The
coverage and performance add-ons put only YAML and Markdown outside `tools/`,
which Biome does not read; nothing in them changed.

**No conflict with the kit's ESLint rules was found.** None of them judges the
order of imports (`newspaper-order` and `component-newspaper` order
declarations), and `pnpm lint` passes on the reformatted starter with no
setting changed for it.

## How it was tested

`pnpm vitest run addons/format-lint`: 68 tests in two files. They run the real
Biome, through the scripts in `addon.json`, in a fresh folder that holds the
two shipped config files.

- `tests/addon.test.mts`: the pin is exact and equals the installed version;
  the gate and `verify` are the check; the check writes nothing, the formatter
  and the fixer write; an unsafe fix is not applied; the two layers; what
  Biome is kept away from; a project with no `.gitignore` is told so and does
  not pass; the starter, and the starter with each other add-on's files, are
  clean.
- `tests/rules.test.mts`: each formatter setting, the import groups, each
  lint rule in the table with a file that breaks it, each exception.

Every test was turned red by a mutant of its own and restored: 69 mutants in
67 tests with `mutation-check.mts`, all killed, each test command first seen
green and selecting one test. The 68th test ("ships no JavaScript file") was
turned red by hand, by adding a `.js` file. Three mutants change a fixture
and not the config, because what those tests pin is Biome's behaviour: the
root wins over the base, the root's rules add to the base's, and a declared
variable is accepted. The tests for the coverage and performance add-ons can
only go red through the starter's files today, since those add-ons ship
nothing Biome reads.

End to end, in projects made by `scripts/create-project.mts --scope @check`:

| Case | Result |
|---|---|
| The add-on alone: `pnpm install`, `pnpm biome:check`, `pnpm gate:full` | pass; 84 files checked |
| coverage, visual, performance and format-lint: `pnpm gate:full`, then `pnpm visual` | pass; 96 files checked; 5 visual tests pass against the committed goldens |
| The check again after the build and the coverage run left `dist/`, `coverage/`, `.turbo/` | pass |
| Each add-on added a second time | 0 files written, `git status` empty |
| An unformatted file | exit 1, `demo.ts format` |
| One file per rule: `useBlockStatements`, `noNonNullAssertion`, `noDefaultExport`, `useExplicitType`, `useImportType`, `useImportExtensions`, `noUndeclaredEnvVars`, `noLeakedRender`, `organizeImports`, `noFocusedTests` (a warning) | exit 1 each, the file and the rule named |
| The same unformatted file under `tools/` | exit 0 |
| `pnpm gate:full` with the unformatted file | exit 1, at `biome:check` |
| Scopes `@a`, `@bettersoftware-io`, `@a-very-long-organisation-name` (the scope changes line lengths and the import group) | check passes |

Not tested: the check on GitHub's runner, and on Windows or Linux at all.
Biome ships a binary per platform; only the macOS arm64 one ran.

## Limits

- **Markdown, YAML and HTML are not read** by Biome 2.5.14 as configured: an
  ill-formed workflow file or `index.html` passes this check.
- **The fixer does not add braces.** In 2.5.14 the fix for
  `useBlockStatements` is marked unsafe, so `pnpm biome:fix` reports it and
  leaves it. (The source config's comment says it is fixed on write.)
- **The project needs a `.gitignore`.** The base tells Biome to honour it;
  with none, Biome stops with "couldn't find an ignore file" and exit 1. The
  starter has one.
- **`biome.json` cannot hold comments**, so the reason for a project's own
  rule goes in the commit, or the project renames the file `biome.jsonc`
  (tried: it extends the base the same way). The base stays `.json` because
  the installer rewrites the scope only in the file types it knows, and
  `.jsonc` is not one. That is why the reasons are in this README and not
  beside the rules.
- **The base is replaced on update**, so an update can make a clean project
  fail: a new rule, or a Biome version that formats differently. Run
  `pnpm biome:fix` after one. A project that edited the base is refused by the
  installer until it moves the edit to `biome.json`.
- **Line width is 80.** A project that wants another sets
  `formatter.lineWidth` in `biome.json` and runs the fixer.
- **`useExplicitType` is a nursery rule.** It asks for types that inference
  already has, and may change between Biome versions.
- **Two linters run**, Biome and ESLint. They do not overlap today. If a
  project adds an ESLint rule about import order or layout, it will fight
  Biome; give that job to one of them.
- This repository now has `@biomejs/biome` as a dev dependency too, for these
  tests. It must stay equal to the version in `addon.json`; a test fails when
  they differ.
