# Add-on: strict lint (types and dead code)

Gives a project two checks the starter does not have: the ESLint rules that
need type information, and [knip](https://knip.dev) for unused files, exports
and dependencies. Both join `gate:fast`.

```bash
node scripts/add-to-project.mts <project> strict-lint
cd <project> && pnpm install && pnpm lint:types && pnpm lint:dead
```

## What it adds

| Part | Where | What it does |
|---|---|---|
| `pnpm lint:types` | `tools/strict-lint/check-types.mts` | Runs ESLint with the config below and `--max-warnings 0`. Prints each finding as `file:line:column  rule  message`, then what to do for each rule that fired |
| `pnpm lint:dead` | `tools/strict-lint/check-dead.mts` | Runs knip with the config below. Prints knip's own report, then what to do |
| Typed rules | `tools/strict-lint/eslint.typed.base.mts` | The three rules, the parser settings and what is not judged. Belongs to the add-on: an update replaces it |
| ESLint config | `tools/strict-lint/eslint.config.mts` | The project's `eslint.config.mts`, then the typed rules. A starting file: written once, then the project's own. A rule is added, changed or switched off here |
| knip config | `tools/strict-lint/knip.jsonc` | What knip reads and what it leaves alone, each line with its reason. A starting file |
| AGENTS section | `AGENTS.md` | What to do with a promise nothing waits for, and with something knip calls unused |

One dev dependency in the root `package.json`: `knip` `^6.17.1`, the range the
source uses. ESLint and typescript-eslint are already in the starter. No
JavaScript file, nothing outside `tools/`, no workflow: the checks run in the
project's existing CI job through `gate:full`.

The project's `eslint.config.mts` is not edited. `pnpm lint` stays as it was: the
architecture rules, none of which needs types, fast enough for an editor hook.
`pnpm lint:types` is a second run with a second config that holds both sets, so
a disable comment for an architecture rule is still counted as used there.

The scripts are `lint:types` and `lint:dead` because the starter already has a
`lint` script, and an add-on may not replace a script the project has.

### Why both are in `gate:fast`

`fast` is for a check that takes seconds and needs nothing beyond
`pnpm install`. Measured on a project made from the starter (macOS arm64,
61 TypeScript files, three runs each after a first one):

| Check | First run | Later runs |
|---|---|---|
| `pnpm lint:types` | 3.5 s | 2.6 s |
| `pnpm lint:dead` | 1.8 s | 0.5 s |

Neither needs a build, a browser or a network. The typed run will grow with
the project, since it loads every package's types; a project where it is no
longer "seconds" moves `pnpm lint:types` from `gate:fast` to `gate:full` in its
own `package.json`.

## The typed rules, with the reason for each

The source is `eslint.config.typed.mts` of ReactiveTraderCloudClone. It turns
on three rules, and all three are kept.

| Rule | Reason |
|---|---|
| `@typescript-eslint/no-floating-promises` | A promise nothing waits for: its failure is unhandled, and the code after it runs before the work is done |
| `@typescript-eslint/no-misused-promises` | A promise where the caller does not wait for one: an `async` callback given to `forEach` or to an event handler, a promise tested in an `if` (always true) |
| `@typescript-eslint/switch-exhaustiveness-check`, with `considerDefaultExhaustiveForUnions` | A `switch` over a union names every member, so a new member is an error at each switch and not a case that silently does nothing. A `default` branch counts as naming the rest |
| `--max-warnings 0` | A warning fails. The wrapper also reports every message ESLint gives, whatever its level |

What differs from the source:

| In the source | Here | Why |
|---|---|---|
| `parserOptions.project` pointing at one umbrella `tsconfig.eslint.json` that lists every package's files | `parserOptions.projectService`: each file is read with the `tsconfig.json` nearest to it | The starter's packages each have a `tsconfig.json` and nothing else, so the nearest one is the one `pnpm typecheck` uses. No second list of files to keep in step. The property the source wanted is kept: a file in no tsconfig is an error, not a silent pass |
| Every file is in the umbrella | The `.mts` files at the project root are read with `tsconfig.tooling.json` | The root has no `tsconfig.json`. This is `allowDefaultProject: ["*.mts"]` |
| The only ignore is `.remember/**` | `tools/**`, `**/node_modules/**`, `**/dist/**`, `**/coverage/**`, `**/reports/**`, `**/.turbo/**` | `.remember` is that repository's own. `tools/` holds installed copies the project does not edit; the rest is generated |

## What knip is told, and why

The source's `knip.json` lists each of its 26 packages with its entry files.
Here one line covers every package, so a new package needs no edit.

| Setting | Reason |
|---|---|
| `packages/*`: `includeEntryExports: true` | The starter's packages export their TypeScript source: `"./*": "./src/*"`. knip takes every file that map names as an entry, and does not judge an entry's exports unless told to. Without this line no export of a library package is ever reported (measured: a new unused export in `packages/domain` was not reported). With it, every export needs an importer: a file in the package, a test, or another package |
| `packages/*`: Playwright and Vite configs also under `tests/**` | The visual add-on keeps `playwright.config.ts` and the host's `vite.config.ts` under `tests/visual/`. knip looks for them at the package root only. Without these two lines eight files and two dependencies of that add-on are reported |
| Root: `entry` is `architecture.config.mts` and `tools/**/*.mts` | The kit loads `architecture.config.mts` by name. Every script under `tools/` is an entry, so nothing in `tools/` is reported and what those scripts import counts as used |
| Root: the stylelint config is `tools/repo-hygiene/stylelint.json` | The repo-hygiene add-on keeps its rules there, and they extend `stylelint-config-standard` |
| Root: `ignoreDependencies` names `dependency-cruiser`, `@manypkg/cli`, `stylelint`, `syncpack` | Each is run as a program by a script in `tools/` that names it in a string (the kit's dependencies gate, repo-hygiene's checks). knip follows imports and `package.json` scripts, not that |
| Root: `ignoreBinaries` names `playwright` | The visual add-on's root scripts run `pnpm --dir packages/client-react exec playwright`. knip reads them as run at the root, where Playwright is not a dependency. Found with visual and without performance, which happens to add `playwright` at the root |
| `--no-config-hints` on the command | The config names files and dependencies of add-ons a project may not have. knip's hints about those would be printed on every run |

Nothing is ignored by kind. No `ignore`, no `exclude`, no `ignoreExportsUsedInFile`.

Not carried over from the source: its `ignore` of `.remember/**` and
`docs/design/**`, `ignoreBinaries` for its own install script, the Babel
entries of `ignoreDependencies`, and the per-package entry lists. They describe
that repository.

What counts as used, as observed with knip 6.39.0:

- An export that only a test imports is used.
- A file another package imports by path (`@app/client-core/testing/appHarness.ts`) is used.
- A type named in the signature of an export that is used is not reported.
- A line of a package's `index.ts` that nothing imports **is** reported, at the
  `index.ts`.

## What changed in the starter and in the visual add-on

So that a new project passes with no manual step. `pnpm gate:full` passes in
`starter/` afterwards (57 tests, as before).

**Found by `lint:types`**

- `packages/server/tsconfig.json`, `packages/integration/tsconfig.json`:
  `vitest.config.ts` added to `include`. No tsconfig included those two files,
  so `pnpm typecheck` never checked them.

**Found by `lint:dead`** (each was exported and imported by nothing)

- `packages/client-core/src/index.ts`: `WsConnection`, `PricesPresenter`,
  `createPricesPresenter`, `STALE_AFTER_MS` no longer re-exported.
- `packages/domain/src/index.ts`: `PriceSimulatorOptions`, `createRandomWalk`
  no longer re-exported.
- `packages/react-bindings/src/index.ts`: `ViewModel`, `MachineView`,
  `useMachine` no longer re-exported.
- `packages/shared/src/index.ts`: `PriceDto`, `PriceMessage`, `ServerMessage`,
  `SERVER_MSG` no longer re-exported. `packages/shared/src/protocol.ts`:
  `SERVER_MSG` is no longer exported (it is used in that file only).
- `packages/client-core/src/testing/fakeWebSocket.ts`: `FakeSocket` is no
  longer exported.

Every one of these is still exported from the file that declares it, apart
from `SERVER_MSG` and `FakeSocket`, and the `./*` export still gives that file
out. No behaviour changed.

**In the visual add-on** (`addons/visual/files/packages/client-react/tests/visual/`)

- `goldens.ts`: `PLATFORM` is no longer exported (used in that file only).
- `host/main.tsx`: imports `STALE_AFTER_MS` from
  `@app/client-core/presenters/pricesPresenter.ts` instead of from
  `@app/client-core`. The host was the only importer of that index line, so a
  project without the visual add-on had a dead line, and a project with it
  needed the line. The five goldens still match.

## How it was tested

`pnpm vitest run addons/strict-lint`: 65 tests in six files.

- `tests/check-types.test.mts`, `tests/check-dead.test.mts`,
  `tests/files.test.mts`: the two wrappers and their library, with the tool
  replaced by a fake. The command line each gives its tool, PASS, FAIL with the
  report and the advice, SKIP when there is nothing to judge, "could not run"
  for exit 2, a missing config, a failure that names nothing, output that is
  not a report.
- `tests/rules.test.mts`: the real ESLint and typescript-eslint, with the
  shipped configs, in a project of one package. Each rule fails on a file that
  breaks it, names the file, and passes the corrected file. `void` and a
  `default` branch are accepted. `tools/`, `dist/`, `coverage/`, `reports/`
  and `.turbo/` are not judged, a package's own `tools/` folder is. A file in
  no tsconfig is a finding. A root `.mts` file is judged. The project's own
  rules run in the same run, and a warning fails.
- `tests/dead.test.mts`: the real knip, with the shipped config, in a small
  project with the starter's shapes (a library that exports its source, an
  application, a package of tests only, vitest configs that reach into
  `tools/`, a kit under `tools/`). It finds a planted unused export, an unused
  line of an `index.ts`, an unused file, an unused dependency; it is quiet on
  each shape in the table above.
- `tests/addon.test.mts`: the manifest, the shipped files, and the starter
  itself (alone and with the visual add-on's files) run through `lint:types`.

Every test but one was turned red by a mutant of its own and restored:
`node addons/coverage/files/tools/coverage/mutation-check.mts addons/strict-lint/tests/mutants.json`,
64 mutants for 64 tests, all killed. Each test command was first run alone and
seen to select exactly one passing test. The 65th test ("ships no JavaScript
file") was turned red by hand, by adding a `.js` file. Two mutants change a
file that is not this add-on's (a starter `tsconfig.json`, the visual add-on's
`tsconfig.json`), because what those two tests pin is that those files are in
a tsconfig.

End to end, in projects made by `scripts/create-project.mts`:

| Case | Result |
|---|---|
| `--scope @check --with strict-lint`: `pnpm install`, the `verify` command, `pnpm gate:full` | pass; 61 files linted with types; 57 tests |
| All seven add-ons: `pnpm gate:full`, then `pnpm visual` | pass; 70 files; Biome checks 96 files; 5 visual tests pass against the committed goldens |
| Both checks again after the build, the coverage run and the visual run left `dist/`, `coverage/`, `reports/` | pass |
| `--scope @a-long-organisation --with visual,strict-lint`: `pnpm gate:full`, then `pnpm visual` | pass; 70 files; 5 visual tests |
| The same scope with `format-lint` too | both checks pass. `pnpm biome:check` fails on five files whose import lines pass 100 characters with that scope. It fails the same way from the commit before this add-on, without it |
| strict-lint with each other add-on alone, and with the other three recommended ones: both checks | pass, seven projects |
| The add-on added a second time | 0 files written, `git status` empty |
| An unawaited promise; an `async` callback given to `forEach`; a `switch` that misses two members | exit 1 each, the file, the line and the rule named |
| An unused export; an unused file in `client-react`; `rxjs` added to `shared/package.json` | exit 1 each, the name and the file named |
| `pnpm gate:full` with the unawaited promise | exit 1, at `lint:types` |

Not tested: the checks on GitHub's runner, and on Linux or Windows at all.
This repository's CI now creates a project with `strict-lint` alone (one more
entry in the `project` matrix); that job has not run. No CI job combines
add-ons, so the visual and repo-hygiene lines of the knip config are held by
the tests here and by the local runs above.

## Limits

- **A file with no export, in a library package, is not found.** The exports
  map names every file under `src/`, so each one is an entry and none can be
  an unused file. A file with exports that nothing imports is reported, as
  unused exports. An unused file is found in a package with no exports map
  (`client-react`). Measured: `console.info(…)` alone in
  `packages/domain/src/useCases/` was not reported; the same file in
  `packages/client-react/src/ui/` was.
- **An `index.ts` is judged like any other file.** A package cannot keep a
  line in its index for a caller that does not exist yet. That is the price
  of the first row of the knip table, and it is why 13 names left the
  starter's four index files. A project that wants its index files left alone
  adds `"ignore": ["src/index.ts"]` to `packages/*` (tried: the unused line
  is then not reported), and gives up findings in them.
- **TypeScript is two installs in the starter.** `tsc` is TypeScript 7;
  the `typescript` package is the 6.x JavaScript API, and typescript-eslint
  (`typescript >=4.8.4 <6.1.0`) reads types through that one. So
  `pnpm typecheck` and `pnpm lint:types` see the same code through two
  compiler versions. No difference showed on the starter. knip 6.39.0 does
  not use TypeScript at all (it parses with oxc), so it does not depend on
  the 6.x install.
- **The starter's dependencies are not installed in this repository**, so in
  the two tests that lint the starter an import of `rxjs` or `@app/domain` has
  no type. They prove every file is in a tsconfig, not that the starter has no
  floating promise. The end-to-end runs prove that. For the same reason no
  test here runs knip on the starter itself.
- **The typed run needs every TypeScript file in a `tsconfig.json`.** A new
  file outside every `include` (a config at a package root, a `scripts/`
  folder) fails with "no tsconfig.json includes this file" until it is added.
  At the project root typescript-eslint's default allows eight files to be
  read with `tsconfig.tooling.json`; a ninth `.mts` file there was not tried.
- **The check is run from the project root.** The config takes
  `process.cwd()` as the place `tsconfig.tooling.json` is. An editor's ESLint
  uses the project's `eslint.config.mts`, not this one, so the typed rules do
  not show while typing.
- **The knip config names other add-ons' dependencies.** It is a starting
  file, written once. If a later add-on runs a new program from a string, its
  dependency is reported until the project adds it to `ignoreDependencies`.
  An update of this add-on does not change the project's `knip.jsonc`.
- **`knip.jsonc` is not rewritten for the project's scope.** The installer
  rewrites `@app/` only in the file types it knows, and `.jsonc` is not one.
  The file names no package, so nothing depends on it today.
- **`lint:types` repeats what `pnpm lint` reports**, since its config holds
  both sets. In `gate:fast` the plain lint runs first and stops the gate, so
  a finding is seen once.
- This repository now has `knip` as a dev dependency too, for these tests, at
  the same range as `addon.json`; a test fails when they differ.
