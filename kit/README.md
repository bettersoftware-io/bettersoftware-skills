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
| `gates/run.mts` | Structure, TypeScript only, dumb UI, port contracts, dependency direction, the paths the agent instructions name, the task cache, every package's scripts, where the Node floor is declared, the hash on the package manager, the one app harness, test ids, types-only packages, the one Playwright version | Node; `dependency-cruiser` for the dependency gate |
| `eslint.config.mts` + `eslint-rules/` | Fourteen AST lint rules of its own (naming, reading order, fixtures, page objects, no browser driver in an end-to-end spec, no real sleeps in tests, one import per module), and the settings of ESLint's rules that go with them: function declarations, blank lines, named object types, no CommonJS, React's hook rules | `eslint`, `typescript-eslint`, `eslint-plugin-react-hooks` |
| `gates/quiet.mts` | Nothing of its own: it runs a gate script of the project and prints only the stage that failed | Node |
| `check-react-policies.mts` | Every package that imports React is under the lint rules for its role, and a client's `reactCompiler` matches its build | `eslint` |
| `check-compiler.mts` | The React Compiler still memoizes each function a client lists as relying on it | `@babel/core` and `babel-plugin-react-compiler` in the client |
| `ci/enable-corepack.mts` | Nothing: it gives a workflow the pnpm that `packageManager` pins, on a Node that no longer ships Corepack | `npm`, which ships with Node |
| `ci/pin-package-manager.mts` | Nothing: it prints the `packageManager` field with the sha512 hash of its release, and writes it with `--write` | The network |
| `hooks/after-edit.mts` | Runs the per-file gates on the file an agent just wrote | Claude Code or Codex |
| `hooks/before-stop.mts` | Refuses to let an agent finish while `gate:full` is red, on any tree that has not already passed it | Claude Code or Codex; git |

## The gates

A project declares its layers once, in `architecture.config.mts`
([example](architecture.config.example.mts)). Every gate reads that file.

| Gate | Fails when |
|---|---|
| `structure` | A workspace package has no declared role; a required role is missing; the domain has no ports folder; a package has a runtime dependency outside its closed list; a client holds source outside its composition root and its UI folder; an integration package holds anything but tests; an e2e package holds a file that is neither a spec, a page object nor in a `testing` folder |
| `typescript-only` | The project holds a `.js`, `.jsx`, `.mjs` or `.cjs` source file that is not listed as an exception |
| `dumb-ui` | A UI file imports the stream library, touches storage, reads configuration, opens a connection, or sets a timer |
| `port-contracts` | A port has no contract test; the contract never calls one of the port's methods; the contract imports an implementation; an adapter folder that implements a port does not run that port's contract |
| `dependencies` | An import points outward; the domain, or a package that asked, uses a Node built-in; the core imports a UI framework; a presenter or a state machine imports an adapter; production code imports test scaffolding; a confined library is imported outside its packages; the UI imports the composition root or an adapter; anything imports an integration package or an e2e package; an e2e package imports any of the application but a client's test ids; there is a cycle |
| `agent-docs` | `AGENTS.md` or `CLAUDE.md` names a file or folder that does not exist |
| `task-cache` | A cached task in `turbo.json` has a key that leaves out the packages a package imports; a package's tsconfig extends a file outside the package that is not a global dependency; a package with tests that need a port caches its `test` task |
| `package-scripts` | A workspace package has no `typecheck` script, or no `test` (or `test:…`) script and no listed reason; an e2e package has a `test` script; a script, the root's or a package's, runs `eslint` without `--max-warnings 0` |
| `node-floor` | A `package.json`, the root's or a package's, has `engines.node`; the root's has no `devEngines.runtime` that names `node` with a version and `"onFail": "error"` |
| `package-manager` | The root `package.json` has no `packageManager`, or one that is not an exact version followed by `+sha512.` and the hash of that release |
| `app-harness` | A test calls the function that builds the whole application, anywhere but the one harness file |
| `test-ids` | A test id is written as a string literal, in a component, a selector or a query, outside the client's test-ids file |
| `types-only` | A package declared `typesOnly` exports a runtime value |
| `playwright-pin` | A `package.json` asks for `@playwright/test` or `playwright` as a range; two ask for two versions; another version is installed; a workflow's Playwright image has another version |

```bash
node tools/arch/gates/run.mts                 # every gate
node tools/arch/gates/run.mts --file src/ui/A.tsx   # per-file gates only: all but dependencies, agent-docs, task-cache, playwright-pin
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

### The e2e role: the application, driven from outside

An end-to-end test drives the built application in a real browser, as a user
would. A package with the role `e2e` holds such tests. It is the opposite of
`integration`: that one may import every layer, this one imports none.

- **It imports none of the application's source** (`dependencies`), from a
  spec, a page object or its Playwright config. A test that imports the code
  it tests is no longer a test of what a user gets. The one exception is a
  client's test-ids file, so that a page object and a component share each id.
  An import that names only types is not an edge, so `import type` reaches the
  types of the wire protocol.
- **Nothing may import it** (`dependencies`).
- **It holds three kinds of file** (`structure`): a spec (`*.spec.ts`), a page
  object (`*.page.ts`), and what both are built on, in a `testing` folder (the
  fixtures file). The lint rules below follow the kind, so a file of no kind
  would be under none of them.
- **It has no `test` script** (`package-scripts`). The task runner would run
  one with every other package's tests, and the full gate would then need a
  browser and a port on every machine. The run is a script of the project's
  root. It still needs `typecheck`.

Two lint rules follow the role:

- `arch/no-browser-driver-in-specs`, on its specs. A spec may not import the
  driver's package, take a driver fixture (`page`, `context`, `browser`,
  `request`) or call a method that finds or reads an element (`locator`,
  `getBy…`, `evaluate`, `waitForSelector`). It takes `test` and `expect` from
  the fixtures file and calls page objects.
- `arch/no-real-sleeps-in-tests`, on every file of the package and not only
  its specs: a `waitForTimeout` in a page object is the same guess.

The `test-ids` gate reads the package like any other, so a test id written as
a string in a page object fails there.

Skip the role for a Playwright tier that is not a test of the whole
application: a screenshot tier that renders components in a host of its own
lives in the client's `tests/` folder and imports what it renders.

### One Playwright version

The npm package brings a browser build, and so does the container image a
workflow runs in. The `playwright-pin` gate holds them to one:

- every `package.json` that asks for `@playwright/test`, or for the
  `playwright` library it is built on, the root's included, names an exact
  version, and all name the same one;
- the version installed in that package is the one it names;
- the tag of every `mcr.microsoft.com/playwright:v…` image in
  `.github/workflows` carries that version.

With no `package.json` that asks for either the gate reports `SKIP`. A project
with one such package and no workflow passes: the exact version was judged.

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

### The Node floor is not in `engines.node`

The tooling is TypeScript that Node runs directly, so it needs a recent Node.
Written as `"engines": { "node": ">=26" }` that floor passes every check and
fails the first deploy: a host's build (`vercel build`, for one) reads the
field, accepts only the Node lines it offers, and stops before the build
starts. No step in CI runs that build. In the source project it failed a real
deploy.

So the floor is `devEngines.runtime` in the root `package.json`:

```json
"devEngines": { "runtime": { "name": "node", "version": ">=26", "onFail": "error" } }
```

A host does not read it. pnpm does, and refuses to install on an older Node,
which it never did for `engines.node`. The `node-floor` gate fails on
`engines.node` in any `package.json` of the workspace, and on a root that does
not declare the floor this way. With no `package.json` at the root it reports
`SKIP`.

Skip the gate's advice only where `engines.node` is a promise to people who
install the package: a library published to npm. Nothing here is published.

### pnpm in CI, on a Node without Corepack

Node 25 and later no longer ship Corepack, so `corepack enable` is not there
to run. `ci/enable-corepack.mts` installs it first:

```yaml
- name: Enable Corepack
  run: node tools/arch/ci/enable-corepack.mts
```

It runs `npm ci` on `ci/corepack/package-lock.json`, which pins one version
with a sha512 hash, in the runner's temporary folder, and puts the `pnpm` shim
on the path of the later steps. An `npm install -g corepack` would do the same
with a version no lockfile holds, which the workflow security lint and OpenSSF
Scorecard both report. The step comes after the checkout, since the script is
in the repository, and the workflow sets `COREPACK_ENABLE_DOWNLOAD_PROMPT` to
`"0"`.

A newer Corepack arrives with a newer kit. A dependency bot does not see the
pin unless it is told to read `tools/arch/ci/corepack`.

### The package manager is pinned by hash

Corepack downloads the pnpm that the root `package.json` names:

```json
"packageManager": "pnpm@12.6.0+sha512.3ef68f95…"
```

With the version alone it runs whatever the registry answers under that
version. With the hash it compares the download first and stops on another
file ("Mismatch hashes"). The lockfile pins what pnpm installs; this is the
only thing that pins pnpm. The `package-manager` gate fails on a field with no
hash, on a version that is not exact, and on a root with no field. With no
`package.json` at the root it reports `SKIP`.

To move to a newer pnpm, or to add the hash to a project that has none:

```bash
node tools/arch/ci/pin-package-manager.mts pnpm@12.7.0 --write
```

It asks the registry for that release's `dist.integrity` and writes it in the
hex form Corepack reads. It needs the network, so it is not part of a gate.
Renovate moves the version and the hash together. A bot that leaves the field
alone leaves it to a person, who runs the script.

There is no case for leaving the hash out where Corepack provides pnpm. A
project that provides it another way still names the version it expects, and
the hash costs it nothing.

### A lint warning fails

ESLint exits 0 on a warning. A rule at "warn", set by the project or by a
preset it takes in, then reports on every run and stops nothing. The
`package-scripts` gate fails on a script that runs `eslint` without
`--max-warnings 0`, in the root `package.json` and in each package's. A script
that passes `--fix` is left alone: a fixer gives no verdict.

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
- An e2e package's import of the application is found when it is a value. A
  type reaches anything, as it does for `vendorOnlyIn`.
- `arch/no-browser-driver-in-specs` matches a call by its method's name,
  whatever it is called on, and a fixture by its name. A page object whose
  method is called `locator`, or a fixture named `page` that is not the
  driver, is reported.
- `playwright-pin` reads the image tag as text, in workflows only. An image
  named in a `Dockerfile` or a compose file is not seen.
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
| The kit's own, in `eslint-rules/` | Fourteen, under the `arch/` name | By kind of file: every source file, tests, page objects, components |
| ESLint's, with the kit's settings | `func-style`, `arrow-body-style`, `func-names`, `lines-between-class-members`, `padding-line-between-statements`, `max-classes-per-file`; `no-restricted-syntax` (an object type with no name, in six positions; the view model kept whole or called through); `no-restricted-globals` (the CommonJS names) | Every `.ts`, `.tsx` and `.mts` file |
| | `no-restricted-syntax` on the whole file | Every `.js`, `.mjs`, `.cjs`, `.jsx` and `.cts` file. The exemptions are `javascriptAllowed` in the architecture config |
| By role | `eslint-plugin-react-hooks` (its `recommended-latest` rules, all as errors); no `style={{…}}` | The `src` of a `client` package |
| | No `useMemo`, `useCallback`, `memo` or default React import | The `src` of a `bindings` package, tests left out |
| | The same four, for another reason: the React Compiler memoizes | The `src` of a `client` package that declares `reactCompiler: true`, tests and page objects left out |
| | `arch/no-browser-driver-in-specs` | The specs in the `src` of an `e2e` package |
| | `arch/no-real-sleeps-in-tests`, beyond the tests it always reads | Every file in the `src` of an `e2e` package |

### Rules that follow a role

`architectureLint()` reads `architecture.config.mts` from the folder ESLint is
run in, the file the gates read, and applies the rows under "By role" to the
packages that declare those roles. A config can also be handed over:
`architectureLint(config)`. Where there is no such file those rows are not
applied, and a JavaScript file has no exemption.

The hook rules are held to a client because a function named `useCase` in any
other package would be read as a hook.

### The React Compiler, and the two checks that hold it

A client whose build runs the React Compiler says so:

```ts
"packages/client-react": {
  role: "client",
  reactCompiler: true,
  compilerTracked: [
    { file: "src/ui/PriceList.tsx", fn: "PriceRowView" },
    { file: "src/ui/Chart.tsx", fn: "Chart", values: ["path"] },
  ],
},
```

With that, the lint bans `useMemo`, `useCallback`, `memo` and the default
React import in the client's source: the compiler memoizes, and a hand-written
memo is noise whose dependency list can drift. A client without the
declaration is not banned from anything, since nothing would memoize in its
place. The bindings are banned either way, for their own reason: a memo there
means logic has moved into the bridge.

The compiler skips what it cannot compile and says nothing, and a rule set by
role can be missing for a package with every run green. Two scripts check
both. Neither is part of `gates/run.mts`: one needs ESLint, the other the
client's own Babel, and each runs in the project root.

```json
"check:react-policies": "node tools/arch/check-react-policies.mts",
"check:compiler": "node tools/arch/check-compiler.mts"
```

**`check-react-policies.mts`** finds every package whose production source
imports `react`, and fails when:

- the package is neither a client nor the bindings, so it gets none of React's
  lint rules. A package that is meant to have none is listed with the reason:
  `reactWithoutPolicies: { "packages/icons": "generated, never edited by hand" }`;
- a client declares `reactCompiler: true` and its `vite.config.ts` does not run
  the compiler, or runs it and does not declare it;
- ESLint, asked about a real file of the package, does not resolve the rule at
  error: the hook rules and the inline-style ban for a client, the memoization
  ban for the bindings and for a client with the compiler. ESLint keeps one
  set of options per rule, so a later block in the project's own config that
  sets `no-restricted-imports` or `no-restricted-syntax` replaces the kit's.

**`check-compiler.mts`** compiles each file under `compilerTracked` with the
compiler the client installs, and fails when the function is not compiled,
when it memoizes fewer values than `minMemoValues` (default 1), or when a
value named in `values` is computed on every render. Use `values` for a value
that used to be a `useMemo` or a `useCallback`: a function can compile and
still leave one value out of every cache.

Both print `SKIP` when there is nothing to judge (no package imports React; no
client declares the compiler, or none tracks a function), and exit 2 when they
cannot run (no ESLint config; the compiler is not installed in the client).

Limits:

- A component that takes its hooks out of a value, as with
  `const { usePrices } = useViewModel()`, is never compiled: the compiler
  needs each hook to be the same function on every render. Such a component
  stays thin and hands props to components that take only props.
- `check-react-policies.mts` reads the compiler from the text of
  `vite.config.ts` (a call of `reactCompilerPreset`, or the plugin's name in
  a string). A build configured some other way is reported as not running it.
- It asks ESLint about one production file per package, and one `.tsx`. A
  rule switched off for a single other file is not seen.
- `check-compiler.mts` reads the compiled text. A value compiled to a
  `function name(…)` declaration is reported as a shape it cannot classify,
  never as memoized.
- Tests are not compiled, so no test runs the compiled components.

### A dependency the project does not have

A project that updates its kit gets the kit's files, not its dependencies.
The ones the lint needs beyond `eslint` and `typescript-eslint` are listed in
`lint-dependencies.mts`. `add-to-project.mts <project> kit` names each one the
project has not installed, under "Still to do by hand". Until it is installed
`eslint` stops with a message that says which package is missing and the
command that adds it; it does not report a clean run.

### What an update leaves to the project

`add-to-project.mts <project> kit` replaces the kit's own files. Four files
were written from a template the kit ships and then belong to the project, so
an update never overwrites them:

| The project's file | The kit's copy of its template |
|---|---|
| `.claude/settings.json` | `tools/arch/hooks/claude.settings.json` |
| `.codex/hooks.json` | `tools/arch/hooks/codex.hooks.json` |
| `AGENTS.md` | `tools/arch/templates/AGENTS.md.txt` |
| `architecture.config.mts` | `tools/arch/templates/architecture.config.mts.txt` |

When an update changes one of those templates it says so, under "Yours to
change": the file, the lines of the template that changed, and what to do.

- A file that is still the old template, word for word, gets the command that
  takes the new one (`cp …`). The update does not run it.
- A file with changes of its own gets "make this change by hand".
- A gate that is new to the project is named with the options of
  `architecture.config.mts` it reads. The list is `gates/gates.json`.

The copies are ordinary kit files, so the record of what was installed
already says when one changed, and the copy about to be replaced is the old
text. Nothing else is stored.

Limits:

- It is said once, by the update that brings the change. A change that was
  not made then is not repeated by the next update; `diff` the copy against
  the project's file to see where the two stand.
- The first update of a project whose kit predates this has no earlier copy
  of `AGENTS.md` or of the example config to compare with, and no list of
  gates. It says nothing about those; the two hook files are covered at once.
- A new option of a gate the project already has shows up only as a changed
  line of the example config.

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
"gate:fast": "node tools/arch/gates/run.mts && eslint --max-warnings 0 . && pnpm typecheck",
"gate:full": "pnpm gate:fast && pnpm test && pnpm build"
```

It runs the script through the quiet runner (next section), so a red gate
sends back the stage that failed. The end of a loud run is whatever was
printed last, which is often a passing stage.

**Which tree it judges.** The one the session stops in. The payload's `cwd`
follows the agent into a worktree; `CLAUDE_PROJECT_DIR` stays at the checkout
the session started in. The hook once read the variable first, so an agent
that worked in `<project>-worktrees/<name>` was judged on the primary
checkout beside it: red worktree, green primary, and it could stop. Now the
root is found from `cwd`: the top of its git checkout, and from there the
nearest folder upward whose `package.json` has a gate script. A stop from
inside a package folder therefore runs the project's gate; before, with no
`CLAUDE_PROJECT_DIR` (as under Codex), it ran none. The variable is read only
when the payload names no folder.

- A session that edited two checkouts is judged on the one it stops in. The
  other is not looked at.
- The gate is run by the copy of the runner beside the hook, which in Claude
  Code is the primary checkout's, on the tree found from `cwd`.

The full gate takes minutes, so the hook does not run it on a tree that has
already passed. After a green run it stores a hash in
`node_modules/.cache/arch/`. While the hash is unchanged the agent finishes at
once; after any edit it is held to the whole gate.

The hash covers what the verdict is taken to depend on: every file git does
not ignore, tracked or not; the `.env` files it does ignore; the version of
Node; and where the tree is. So a record is one checkout's own: a worktree
with the same files as a green primary checkout is still judged, and a
`node_modules` that is a link to another checkout's is not read through.

- Where that cannot be established the gate runs every time: outside a git
  repository, where a file cannot be read, and in a tree that holds a
  repository of its own (a submodule, a nested clone), whose files git lists
  as one entry.
- **What it cannot judge it sends back.** A `package.json` that is not JSON,
  a runner that cannot start, anything that throws: the answer is "nothing is
  verified", not silence. Apart from the second stop below, the agent
  finishes without a green gate in two cases only: no folder from `cwd`
  upward has a gate script, or the tree is on record as green.
- **It is a guard against stopping early, not a lock.** The record is a file.
  An agent that sets out to cheat can write it, as it can rewrite the
  `gate:full` script or the hook itself. CI, which runs the same script from
  nothing, is what catches that.
- **An input the hash leaves out can change the verdict without changing the
  record**: an environment variable, a tool installed outside the project, a
  file edited by hand inside `node_modules`.
- A gate that does not finish in nine minutes is reported as "nothing is
  verified", never as a pass. The hook's own timeout in the host's settings is
  ten minutes, and a hook the host has to kill blocks nothing, so the hook
  answers by itself whatever the gate does: at nine minutes it tells the
  runner to stop, twenty seconds later it kills it, and five seconds after
  that it answers without it. A run that was stopped is never remembered as
  green, whatever it exited with.
- It blocks once. If the gate is still red when the agent tries to stop a
  second time, the agent is let through to report the problem, so an
  unfixable finding ends in a message to you and never in a loop.

It was `gate:fast` until a run with the smallest model stopped there with
`gate:full` red and reported green
([the record](../docs/small-model-2026-10-05.md)).

## A gate that prints failures only

`pnpm gate:full` prints every passing test and every cached task. CI wants
that. An agent does not: the smallest model ran out of context on it
([the record](../docs/small-model-2026-10-05.md)).

```json
"gate:fast:quiet": "node tools/arch/gates/quiet.mts gate:fast",
"gate:full:quiet": "node tools/arch/gates/quiet.mts gate:full"
```

```
ok    pnpm gates (0.6s)
      SKIP types-only — no package is declared typesOnly, so there was nothing to check
ok    pnpm lint (9.8s)
ok    pnpm typecheck (4.1s)
FAIL  pnpm test (exit 1, 12.3s)

…the whole output of `pnpm test`, and of nothing else…

not run:
      pnpm build
      pnpm coverage

gate:full is red.
```

- **It holds no list of stages.** It reads the script from `package.json` on
  each run and splits its `&&` chain. A part that runs another chain of the
  project (`pnpm gate:fast`) is replaced by that chain's parts. A command an
  add-on joined to a gate is a stage like any other, and there is still one
  definition of the gate.
- **It splits a chain only when no part can reach the next through the
  shell.** Each stage runs in a shell of its own. It once split every chain:
  `cd sub && node check.mjs` then ran the check in the wrong folder,
  `export STRICT=1 && …` lost the variable, and both exited 0 where pnpm
  exits 1, which the stop hook remembered as a green tree. Now every part
  must start with a program, after any `NAME=value` in front: a word the
  stage's own shell finds as a file on the `PATH` (`pnpm`, `node`, what
  `node_modules/.bin` holds). The shell is asked with `command -v`; no list
  of its builtins is kept, so an unknown word is never taken for harmless.
  `cd`, `export`, `set`, `.`, `eval`, `exec`, a bare `NAME=value`, `!`, `{`,
  a function, and a chain that reads `$?`, `$_`, `$!` or `${…}`: the script
  runs whole, in one shell, as pnpm runs it. That is only less exact about
  which part failed. The shell asked is `/bin/sh`, so the answer fits the
  machine: bash on a Mac, dash on Ubuntu. A word with a slash is a path, and
  the file is looked at instead, because shells answer differently about one
  (dash says any path that exists is a command). A test runs each of these
  by pnpm and by the runner and compares the exit codes with each other; it
  states no number that only one shell gives.
- **It runs what pnpm would run, or it lets pnpm run it.** A part is opened
  up only when that is certain: `pnpm run <name>` with nothing after it, or
  `pnpm <name>` where the name holds a colon. `pnpm audit` is pnpm's own
  command even in a project with an `audit` script, and no command of pnpm
  has a colon. A part with a flag or an argument, a script with a `pre` or
  `post` script beside it, and `npm run` or `yarn` are run whole, as written.
  A stage from an opened script gets the environment pnpm gives that script.
  A test runs each of these both ways and compares what ran.
- **A `SKIP` line is kept.** A check that judged nothing says so on a line
  that starts with `SKIP`, and has not passed. Those lines are printed under
  the stage's own line, so quiet never turns "not verified" into silence.
- **The exit code is the failing stage's own**, which is what `pnpm gate:full`
  exits with. Quiet changes what is printed, never the verdict.
- **Nothing is lost.** A failing stage's output is printed whole, however
  long. Everything every stage printed is also in
  `node_modules/.cache/arch/last-gate.log`, written as it arrives.
- **A stage that is stopped is a failure, and the runner never waits on
  one.** Told to terminate (the stop hook's timeout does this), it sends the
  stage's process group SIGTERM, five seconds later SIGKILL, and two seconds
  after that goes on without it. It prints what the stage had said and exits
  with the signal's code, never 0. A second signal ends it at once.
- **It trusts the project as far as `pnpm run` does.** The commands come from
  `package.json` and run in a shell. `--root` runs the gate of the folder it
  names, as `cd` there and `pnpm gate:full` would.
- **The log is never written through a symbolic link**, at the file or at any
  folder above it. The same holds for the stop hook's record.

**Why a separate script, and not a flag or the default.** The loud scripts
stay as they are: they are what add-ons append to, and what CI and a person
run. An environment variable could not make `pnpm gate:full` quiet without
turning that script into a call to a runner, and then an add-on would have
nothing to append to. Quiet as the default would hide output from CI, where
the full log is the record. So quiet is a second way to run the same script,
and the two consumers each take the one that suits them: the stop hook calls
the runner itself, in every project, with no script needed; CI keeps
`pnpm gate:full`.

Known limits:

- A script that uses the shell for more than `&&` (a pipe, `;`, `||`, a
  subshell) is run as one stage. The verdict is the same; the report cannot
  say which part failed.
- A stage is a line of a script. What a task runner runs inside one stage
  (`turbo run test` over six packages) is one stage: when it fails, all of
  its output is printed, the passing packages included.
- Not run on Windows: a stage is stopped through its process group.
- A bare `pnpm typecheck` is one stage even when `typecheck` is a chain: a
  bare word may be a command of pnpm. Write `pnpm run typecheck` in the gate
  to see its parts.
- The environment given to a stage was measured on pnpm 12.6: `INIT_CWD`,
  `PNPM_SCRIPT_SRC_DIR`, `npm_lifecycle_event`, `npm_lifecycle_script`,
  `npm_package_json`, `npm_package_name`, `npm_package_version`, `NODE`,
  `npm_node_execpath`, and the project's `node_modules/.bin` first on the
  PATH. Not set: `npm_execpath` and `npm_config_user_agent`, unless the
  runner was itself started by pnpm, and pnpm's `script-shell` setting.
- At most 32 MB of one stage's output is held in memory. Past that a failure
  shows the end and says the start is in the log. A `SKIP` line is still
  found anywhere in it.
- A stage that exits while something it started still holds its output open
  is waited on for one second, then reported by its exit code.
- A process that leaves the stage's process group (a daemon in a session of
  its own) is not stopped with the stage.

## Tests

```bash
pnpm test
```

The gate and hook tests run against five fixture projects in `gates/fixtures/`
(`clean`, `broken`, `dormant`, `javascript`, `no-workspace`). The two React
checks run against two more, `react-clean` and `react-broken`.
