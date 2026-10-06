# The kit

Deterministic checks for the architecture, and the hooks that run them. The
kit is copied into a new project as `tools/arch/` by
`scripts/create-project.mts`; everything in it also runs from here against any
folder, which is how it is tested.

The checks do not depend on which model, or which person, wrote the code.

Everything here is TypeScript. The scripts are `.mts` files that Node runs
directly by stripping the types, which needs Node 22.18 or later, and
`pnpm typecheck` is what checks them.

## What is in it

| Part | What it checks | Needs |
|---|---|---|
| `gates/run.mts` | Structure, TypeScript only, dumb UI, port contracts, dependency direction, the paths the agent instructions name, the task cache, every package's scripts, the one app harness, test ids, types-only packages | Node; `dependency-cruiser` for the dependency gate |
| `eslint.config.mts` + `eslint-rules/` | Thirteen AST lint rules of its own (naming, reading order, fixtures, page objects, no real sleeps in tests, one import per module), and the settings of ESLint's rules that go with them: function declarations, blank lines, named object types, no CommonJS, React's hook rules | `eslint`, `typescript-eslint`, `eslint-plugin-react-hooks` |
| `hooks/after-edit.mts` | Runs the per-file gates on the file an agent just wrote | Claude Code or Codex |
| `hooks/before-stop.mts` | Refuses to let an agent finish while `gate:full` is red, on any tree that has not already passed it | Claude Code or Codex; git |

## The gates

A project declares its layers once, in `architecture.config.mts`
([example](architecture.config.example.mts)). Every gate reads that file.

| Gate | Fails when |
|---|---|
| `structure` | A workspace package has no declared role; a required role is missing; the domain has no ports folder; a package has a runtime dependency outside its closed list; a client holds source outside its composition root and its UI folder; an integration package holds anything but tests |
| `typescript-only` | The project holds a `.js`, `.jsx`, `.mjs` or `.cjs` source file that is not listed as an exception |
| `dumb-ui` | A UI file imports the stream library, touches storage, reads configuration, opens a connection, or sets a timer |
| `port-contracts` | A port has no contract test; the contract never calls one of the port's methods; the contract imports an implementation; an adapter folder that implements a port does not run that port's contract |
| `dependencies` | An import points outward; the domain, or a package that asked, uses a Node built-in; the core imports a UI framework; a presenter or a state machine imports an adapter; production code imports test scaffolding; a confined library is imported outside its packages; the UI imports the composition root or an adapter; anything imports an integration package; there is a cycle |
| `agent-docs` | `AGENTS.md` or `CLAUDE.md` names a file or folder that does not exist |
| `task-cache` | A cached task in `turbo.json` has a key that leaves out the packages a package imports; a package's tsconfig extends a file outside the package that is not a global dependency; a package with tests that need a port caches its `test` task |
| `package-scripts` | A workspace package has no `typecheck` script, or no `test` (or `test:…`) script and no listed reason |
| `app-harness` | A test calls the function that builds the whole application, anywhere but the one harness file |
| `test-ids` | A test id is written as a string literal, in a component, a selector or a query, outside the client's test-ids file |
| `types-only` | A package declared `typesOnly` exports a runtime value |

```bash
node tools/arch/gates/run.mts                 # every gate
node tools/arch/gates/run.mts --file src/ui/A.tsx   # per-file gates only: all but dependencies, agent-docs, task-cache
node tools/arch/gates/run.mts --json          # machine-readable
```

Exit `0` is no findings, `1` is findings, `2` is "could not run".

### TypeScript only, unless the project says otherwise

TypeScript is the default. With it, any JavaScript source file fails the
`typescript-only` gate, in the editor hook as well as in the full run. A file
whose loader cannot read TypeScript is listed with the reason:

```ts
javascriptAllowed: {
  "stylelint.config.mjs": "stylelint's config loader cannot read .mts",
},
```

A project on a runtime too old to run `.mts` declares `language: "javascript"`
(in an `architecture.config.mjs`). The gate then reports `SKIP` with that
reason; it does not quietly pass.

### The integration role: where the two sides meet

The layer rules keep the client from importing the server, so each side is
tested against the shared protocol alone. Nothing inside the layers can show
that the two agree. A package with the role `integration` is the one place
that may import every other package, so it can run a client adapter against
the real server.

Two rules keep that from becoming a way round the layers:

- nothing may import an integration package (`dependencies`);
- it holds only tests: files named `*.test.ts`, and helpers in a
  `__testUtils__` folder (`structure`).

### The paths the agent instructions name

`AGENTS.md` says which file shows each pattern. When such a file is renamed or
deleted, the line still reads well, and an agent told to copy a file that is
gone invents one. The `agent-docs` gate fails on a path that does not exist.

It judges only what it can judge without guessing:

| Judged | Not judged |
|---|---|
| A path in backticks whose first part exists at the repository root (`packages/…`, `tools/…`); a `:line` suffix is ignored | A path that starts somewhere else (`src/app`, `client-core/src`) |
| The target of a relative link | A web link, a link out of the repository |
| | Anything with a placeholder or a wildcard, a command, a fenced code block |
| | A folder of generated files (`dist`, `coverage`, `reports`, `node_modules`) |
| | A block a tool manages, from `<!-- BEGIN:name -->` to `<!-- END:name -->` |

It does not know when a new pattern deserves a row: that is judgement. The
files it reads are `instructionFiles` in the config (default `AGENTS.md` and
`CLAUDE.md`).

### A contract calls every method of its port

A port gains a method, both implementations gain it, and the contract is left
as it was. Every test stays green and nothing holds the two implementations to
the same behaviour. The gate reads the methods of `interface <Name>Port` and
fails for each one the contract file never calls. Comments are blanked first,
so a mention in prose is not a call. A member typed as a function
(`latest: (symbol: string) => …`) counts; a member typed with a name
(`latest: Fetcher`) cannot be read as one and is not judged. A port that is
not declared as an interface of that name fails, because its methods cannot be
read at all.

### A cached result that ignores what it read

When packages import each other's source, a package's typecheck and tests read
the packages it imports. Turbo keys a task on that package's own files unless
the task graph says otherwise, so a change upstream replays "passed" for every
dependent. CI starts with an empty cache and never shows it; a developer's
machine and the stop hook do.

The gate reads `turbo.json` and needs no turbo to run:

- every cached task must depend on the packages a package imports, directly
  (`^build`) or through another task. Turbo's own remedy keeps tasks parallel:
  `"transit": { "dependsOn": ["^transit"] }`, a task that matches no script,
  and `dependsOn: ["transit"]` on `typecheck` and `test`;
- a file a package's tsconfig extends from outside the package (the shared
  `tsconfig.base.json`) must be under `globalDependencies`.

A task that reads nothing outside its own package is listed with the reason:

```ts
tasksThatReadNothingUpstream: {
  format: "the formatter reads one file at a time and resolves no import",
},
```

Not judged: a task with `"cache": false`, and a root task (`//#name`).

### Tests that need a port, where none can be opened

Some sandboxes do not let a process listen on a port; Codex's default one does
not. A test that starts a real server fails there with `listen EPERM`, the
project's gate goes red on correct work, and the steps after the failing
package never run. Seen in Codex: a correct change to the domain was reported
as "`pnpm gate:full` did not pass".

So a test that opens a real port says so in its name, `*.port.test.ts`, and
the package's vitest config asks `testing/portTests.mts` which files to leave
out:

```ts
import { configDefaults, defineConfig } from "vitest/config";
import { portTestsToSkip } from "../../tools/arch/testing/portTests.mts";

export default defineConfig(async () => {
  const skipped = await portTestsToSkip();

  return { test: { exclude: [...configDefaults.exclude, ...skipped], passWithNoTests: skipped.length > 0 } };
});
```

- Where a port can be opened nothing is left out.
- Where none can, those files are left out and the run prints one `SKIP` line
  that says they were not verified.
- **In CI nothing is ever left out.** There a test that cannot run fails, so a
  skip is never how a change reaches the main branch.
- The stop hook runs the gate outside the sandbox, where they do run.

A package with such tests must not cache its `test` task, or a run that left
them out inside a sandbox would be replayed as the result outside it. The
`task-cache` gate fails on that; the package's own `turbo.json` turns the
cache off for that one task.

A skip is weaker than a failure, and the name is a convention no gate can
check: a test that opens a port under another name simply fails in the
sandbox, as before.

### Every package is typechecked and tested

A task runner runs a task only in the packages that declare its script, and
says nothing about the rest. A new package with no `typecheck` script is never
typechecked, with every run green. The `package-scripts` gate reads each
workspace package's `package.json` and fails when it has no `typecheck`, or no
`test` and no `test:…` script. An integration package needs both too.

A package that has no tests says so, with the reason. It still needs
`typecheck`:

```ts
packagesWithoutTests: {
  "packages/core-api": "it holds only types, so there is nothing to run",
},
```

### Test scaffolding stays in tests

A `testing/` folder, a page object (`*.page.*`), a `*.testHelpers.*` file, a
`__tests__` or `__testUtils__` folder and a test are written for tests. The
`dependencies` gate fails when a production file in any declared package
imports one, from its own package or another: a fake would ship in the product.

### A core is handed its ports

In a `core` package, only the adapters themselves, the tests, and the entry
(`src/index.ts`, which re-exports the adapters for the client's composition
root) may import a folder listed under `adapters`. A presenter, a state
machine and the function that composes them take the port as an argument.
`mayImportAdapters` on the package replaces the list of exempt files.

### A contract imports no implementation

A contract is handed the implementation it tests. One that imports a simulator
or an adapter can only ever test that one. The `port-contracts` gate fails on
an import, in a file under `__contracts__`, that lands in a folder listed
under `adapters` or in another workspace package. An npm package is not
judged: the test runner is one.

### The application is built in one test helper

The function that composes the application takes every port. A test that
calls it wires its own set of fakes, so a port added later has to be added to
each such test. The `app-harness` gate fails when a test, a page object or a
file in a `testing/` folder calls it, except the one harness. Both names are
options of the `core` package, with the starter's as defaults:

```ts
"packages/client-core": {
  role: "core",
  compose: "createApp",
  appHarness: "src/testing/appHarness.ts",
},
```

When no core package defines that function the gate reports `SKIP`.

### One file holds the test ids

`data-testid="price-row"` in a component and `getByTestId("price-row")` in a
page object are two copies of one name. The `test-ids` gate fails on a test id
written as a string literal: the attribute, a `[data-testid="…"]` selector,
and any `…ByTestId("…")` query. It reads every declared package and leaves
out the client's test-ids file, `testids.ts` in its UI folder unless the
client says otherwise (`testIds`).

### No Node built-in, for any package that asks

The domain uses no Node built-in. Any other package asks for the same rule
with `noNodeBuiltins: true`, which is how a package that ends up in a browser
is kept loadable there. Tests and test scaffolding are left out.

### A library kept to the packages that own it

`npm` on a package is the closed list of what its `package.json` may depend
on. `vendorOnlyIn` is the other half, about imports: the library may be
imported only from the packages listed, tests included.

```ts
vendorOnlyIn: {
  react: ["packages/react-bindings", "packages/client-react"],
  ws: ["packages/server"],
},
```

A name that ends in `/` covers a whole scope. An import that names only types
is not counted.

### A package of types exports no value

A package declared `typesOnly: true` is safe to import from anywhere because
it adds nothing at runtime. The `types-only` gate fails on each
`export const`, `let`, `var`, `function`, `class` or `enum`, each
`export default` of a value, each `export { … }` with a member that is not
marked `type`, and each `export * from`. Tests are left out. With no such
package the gate reports `SKIP`.

### A gate that judged nothing has not passed

Four cases are reported instead of being read as clean:

- **No layers declared.** Without `architecture.config.mts` the runner exits 2.
- **Nothing to judge.** A gate that found no files to check prints `SKIP` with
  the reason, never `PASS`.
- **A script reached through a symlink.** The entry-point check compares real
  paths, so a linked copy of a gate or hook runs instead of exiting clean
  having done nothing.
- **Blind dependency rules.** A workspace import that resolves to built output,
  or does not resolve, never matches a source-path rule. The dependency gate
  checks where every workspace import landed and fails if one missed its
  package's `src`. The path mapping it needs is generated on each run from the
  workspace, so there is no second file to keep in step.

### Known limits

- `ui-never-imports-adapters` sees a direct import of an adapter module. It does
  not see an adapter re-exported through a package's index.
- `port-contracts` works at the level of an adapter folder: it proves the folder
  runs the port's contract, not that each adapter in it does.
- `dumb-ui` matches text after stripping comments. A banned name inside a string
  literal is reported.
- `name-fixture-factories` sees a zero-parameter fixture. A factory that takes
  arguments and has a bare-noun name is not caught.
- `takes-ports-as-arguments`, like the rule above, sees a direct import of an
  adapter module, not one re-exported through a package's index. The same
  holds for a contract that imports its own package's index.
- A rule that follows an option is not made when the option is absent: no
  `adapters`, no `takes-ports-as-arguments`; no `vendorOnlyIn`, no confinement.
  The `dependencies` gate does not report those as skipped.
- `app-harness` sees a call, `createApp(…)`. The function passed by name to
  something else that calls it is not caught.
- `test-ids` and `types-only` match text after stripping comments. A test id
  built in a template literal is reported, unless the literal opens with
  `${` (a selector built from a constant); `export declare` is not.

## Lint rules

```js
// eslint.config.mts
import { architectureLint } from "./tools/arch/eslint.config.mts";

export default [...architectureLint()];
```

ESLint loads a TypeScript config with `--flag unstable_native_nodejs_ts_config`
on Node 24 or later, or with `jiti` installed.

The block holds three kinds of rule. Each has its reason beside it in
`eslint.config.mts`.

| Kind | Rules | Applies to |
|---|---|---|
| The kit's own, in `eslint-rules/` | Thirteen, under the `arch/` name | By kind of file: every source file, tests, page objects, components |
| ESLint's, with the kit's settings | `func-style`, `arrow-body-style`, `func-names`, `lines-between-class-members`, `padding-line-between-statements`, `max-classes-per-file`; `no-restricted-syntax` (an object type with no name, in six positions; the view model kept whole or called through); `no-restricted-globals` (the CommonJS names) | Every `.ts`, `.tsx` and `.mts` file |
| | `no-restricted-syntax` on the whole file | Every `.js`, `.mjs`, `.cjs`, `.jsx` and `.cts` file. The exemptions are `javascriptAllowed` in the architecture config |
| By role | `eslint-plugin-react-hooks` (its `recommended-latest` rules, all as errors); no `style={{…}}` | The `src` of a `client` package |
| | No `useMemo`, `useCallback`, `memo` or default React import | The `src` of a `bindings` package, tests left out |

### Rules that follow a role

`architectureLint()` reads `architecture.config.mts` from the folder ESLint is
run in, the file the gates read, and applies the last two rows to the
packages that declare those roles. A config can also be handed over:
`architectureLint(config)`. Where there is no such file those two rows are not
applied, and a JavaScript file has no exemption.

The hook rules are held to a client because a function named `useCase` in any
other package would be read as a hook.

### A dependency the project does not have

A project that updates its kit gets the kit's files, not its dependencies.
The ones the lint needs beyond `eslint` and `typescript-eslint` are listed in
`lint-dependencies.mts`. `add-to-project.mts <project> kit` names each one the
project has not installed, under "Still to do by hand". Until it is installed
`eslint` stops with a message that says which package is missing and the
command that adds it; it does not report a clean run.

### With a formatter

No rule here is a formatting rule, so there is nothing for
`eslint-config-prettier` to switch off and the kit does not use it. Two rules
add blank lines and one rewrites an arrow's body; a formatter keeps both.
Run the formatter after `eslint --fix`: the fixer writes `{return x}` on one
line and leaves the layout to it.

## Hooks

`hooks/claude.settings.json` goes to `.claude/settings.json`, and
`hooks/codex.hooks.json` to `.codex/hooks.json`. Both point at the same two
scripts. Codex runs a hook only after it has been reviewed and trusted with
`/hooks`.

Both hooks have been run in Codex as well as in Claude Code.

The stop hook runs the project's `gate:full` script, the one CI runs, so
"green" has one definition for the agent, a person and CI. A project with no
`gate:full` is held to `gate:fast`.

```json
"gate:fast": "node tools/arch/gates/run.mts && eslint . && pnpm typecheck",
"gate:full": "pnpm gate:fast && pnpm test && pnpm build"
```

The full gate takes minutes, so the hook does not run it on a tree that has
already passed. After a green run it stores a hash in
`node_modules/.cache/arch/`. While the hash is unchanged the agent finishes at
once; after any edit it is held to the whole gate.

The hash covers what the verdict is taken to depend on: every file git does
not ignore, tracked or not; the `.env` files it does ignore; and the version
of Node.

- Where that cannot be established the gate runs every time: outside a git
  repository, and in a tree that holds a repository of its own (a submodule, a
  nested clone), whose files git lists as one entry.
- **It is a guard against stopping early, not a lock.** The record is a file.
  An agent that sets out to cheat can write it, as it can rewrite the
  `gate:full` script or the hook itself. CI, which runs the same script from
  nothing, is what catches that.
- **An input the hash leaves out can change the verdict without changing the
  record**: an environment variable, a tool installed outside the project, a
  file edited by hand inside `node_modules`.
- A gate that does not finish in nine minutes is reported as "nothing is
  verified", never as a pass. The hook's own timeout in the host's settings is
  ten minutes.
- It blocks once. If the gate is still red when the agent tries to stop a
  second time, the agent is let through to report the problem, so an
  unfixable finding ends in a message to you and never in a loop.

It was `gate:fast` until a run with the smallest model stopped there with
`gate:full` red and reported green
([the record](../docs/small-model-2026-10-05.md)).

## Tests

```bash
pnpm test
```

The gate and hook tests run against five fixture projects in `gates/fixtures/`
(`clean`, `broken`, `dormant`, `javascript`, `no-workspace`).
