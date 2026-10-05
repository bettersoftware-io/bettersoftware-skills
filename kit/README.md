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
| `gates/run.mts` | Structure, TypeScript only, dumb UI, port contracts, dependency direction, the paths the agent instructions name | Node; `dependency-cruiser` for the dependency gate |
| `eslint.config.mts` + `eslint-rules/` | Twelve AST lint rules: naming, reading order, fixtures, page objects, no real sleeps in tests | `eslint`, `typescript-eslint` |
| `hooks/after-edit.mts` | Runs the per-file gates on the file an agent just wrote | Claude Code or Codex |
| `hooks/before-stop.mts` | Refuses to let an agent finish while `gate:fast` is red | Claude Code or Codex |

## The gates

A project declares its layers once, in `architecture.config.mts`
([example](architecture.config.example.mts)). Every gate reads that file.

| Gate | Fails when |
|---|---|
| `structure` | A workspace package has no declared role; a required role is missing; the domain has no ports folder; a package has a runtime dependency outside its closed list; a client holds source outside its composition root and its UI folder; an integration package holds anything but tests |
| `typescript-only` | The project holds a `.js`, `.jsx`, `.mjs` or `.cjs` source file that is not listed as an exception |
| `dumb-ui` | A UI file imports the stream library, touches storage, reads configuration, opens a connection, or sets a timer |
| `port-contracts` | A port has no contract test, or an adapter folder that implements a port does not run that port's contract |
| `dependencies` | An import points outward; the domain uses a Node built-in; the core imports a UI framework; the UI imports the composition root or an adapter; anything imports an integration package; there is a cycle |
| `agent-docs` | `AGENTS.md` or `CLAUDE.md` names a file or folder that does not exist |

```bash
node tools/arch/gates/run.mts                 # every gate
node tools/arch/gates/run.mts --file src/ui/A.tsx   # per-file gates only
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

## Lint rules

```js
// eslint.config.mts
import { architectureLint } from "./tools/arch/eslint.config.mts";

export default [...architectureLint()];
```

ESLint loads a TypeScript config with `--flag unstable_native_nodejs_ts_config`
on Node 24 or later, or with `jiti` installed.

## Hooks

`hooks/claude.settings.json` goes to `.claude/settings.json`, and
`hooks/codex.hooks.json` to `.codex/hooks.json`. Both point at the same two
scripts. Codex runs a hook only after it has been reviewed and trusted with
`/hooks`.

Both hooks have been run in Codex as well as in Claude Code.

The stop hook runs the project's `gate:fast` script, so "green" has one
definition for the agent, a person and CI:

```json
"gate:fast": "node tools/arch/gates/run.mts && eslint . && pnpm typecheck"
```

It blocks once. If the gate is still red when the agent tries to stop a second
time, the agent is let through to report the problem, so an unfixable finding
ends in a message to you and never in a loop.

## Tests

```bash
pnpm test
```

The gate and hook tests run against three fixture projects in `gates/fixtures/`
(`clean`, `broken`, `dormant`).
