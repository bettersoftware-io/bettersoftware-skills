# Add-ons

An add-on is an optional set of checks that is added to a project created from
the starter: coverage gates and reports, visual goldens, rendering-performance
checks. The starter does not include them; a project takes the ones it wants.

```bash
node scripts/add-to-project.mts <project> coverage
```

Like the kit, an add-on is files in the project, not instructions in an agent.
It applies to everyone who works on the project, in any harness and in CI.

## What an add-on is made of

```
addons/<name>/
  addon.json           what to add to package.json files, and how to prove it works
  files/               copied into the project, at the same relative paths
  AGENTS.section.md    appended to the project's AGENTS.md
  README.md            for readers of this repository: what it adds, how it was tested, its limits
  tests/               tests of the add-on's own scripts; run by this repository, never copied
```

`addon.json`:

```json
{
  "name": "coverage",
  "summary": "One line: what the project gains.",
  "packageJson": {
    ".": { "scripts": { "coverage": "…" }, "devDependencies": { "…": "…" } },
    "packages/*": { "scripts": { "test:coverage": "…" } },
    "packages/client-react": { "devDependencies": { "…": "…" } }
  },
  "gates": { "fast": ["pnpm perf:check"], "full": [] },
  "verify": "pnpm coverage"
}
```

- A `packageJson` key is a path from the project root. `packages/*` means every
  workspace package.
- `gates` joins commands to the project's own gates, so the agent's stop hook
  and the existing CI job run them. `fast` is for a check that takes seconds
  and needs nothing installed beyond `pnpm install`; it is appended to
  `gate:fast` (and so runs in `gate:full` too). `full` is appended to
  `gate:full` only. A check that needs a browser, a container or committed
  goldens joins neither, and runs in the add-on's own workflow.
- `verify` is the one command that proves the add-on works in a project that
  has just received it.

## Rules

1. **An add-on only adds.** New files, new scripts, new dev dependencies. It
   never edits a file the project already has, except `AGENTS.md` (its section)
   and `package.json` files (through `addon.json`). If something seems to need
   an edit, find the way that does not: a command-line flag, a new config file
   that extends the old one, a workflow file of its own.
2. **The project still passes `pnpm gate:full` with the add-on in it.** That
   includes the `typescript-only` gate: no `.js`, `.mjs` or `.cjs` file.
3. **Tooling lives in `tools/<name>/`** as `.mts` files that plain `node` runs:
   erasable syntax only, relative imports spelled with their extension. The
   project typechecks `tools/**/*.mts` and its lint ignores `tools/`.
4. **Root scripts do not use `turbo run` for a new task**, since that would
   mean editing `turbo.json`. Use `pnpm -r run <script>` or call the tool.
5. **CI is a workflow file of the add-on's own** in
   `files/.github/workflows/`, with actions pinned by commit like the starter's
   `ci.yml`, and the narrowest `permissions` that work.
6. **Everything checkable is checked.** A rule a machine can verify is a script
   that fails, with a message that says what is wrong and what to do. A script
   that could not run, or found nothing to judge, says so (`SKIP`, or exit 2);
   it never reports a pass.
7. **`AGENTS.section.md` carries only what a machine cannot check**: when to do
   something, how to decide, the runbook for a change. Short, plain words, and
   every rule says when to skip it.
8. **Every script has tests, and every test is shown able to fail** by a
   mutant: break the code, see the test go red, restore.
