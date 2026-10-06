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
  "recommended": false,
  "packageJson": {
    ".": { "scripts": { "coverage": "…" }, "devDependencies": { "…": "…" } },
    "packages/*": { "scripts": { "test:coverage": "…" } },
    "packages/client-react": { "devDependencies": { "…": "…" } }
  },
  "gates": { "fast": ["pnpm perf:check"], "full": [] },
  "startingFiles": ["packages/client-react/tests/visual/scenarios.ts", "packages/client-react/tests/visual/goldens/"],
  "hostSettings": { ".claude/settings.json": { "permissions": { "ask": ["Bash(git push *--force*)"] } } },
  "verify": "pnpm coverage"
}
```

- `recommended` is true for an add-on a new project should take unless it has
  a reason not to. It decides what is selected to begin with when a person is
  offered the list, and what `create-project.mts --with recommended` adds.
- A `packageJson` key is a path from the project root. `packages/*` means every
  workspace package.
- `gates` joins commands to the project's own gates, so the agent's stop hook
  and the existing CI job run them. `fast` is for a check that takes seconds
  and needs nothing installed beyond `pnpm install`; it is appended to
  `gate:fast` (and so runs in `gate:full` too). `full` is appended to
  `gate:full` only. A check that needs a browser, a container or committed
  goldens joins neither, and runs in the add-on's own workflow.
- `startingFiles` are the files the project is meant to edit: its scenarios,
  its golden images, its settings. They are written when the add-on is first
  added and never touched again, so a later update cannot overwrite the
  project's work. A path ending in `/` names a whole folder. Every other file
  belongs to the add-on, and an update replaces it. When a later version of
  the add-on changes a starting file, the update names the project's file
  under "Yours to change" and shows the lines that changed. For that it keeps
  a copy of each text starting file in `tools/templates/`; an image gets no
  copy and no notice.
- `verify` is the one command that proves the add-on works in a project that
  has just received it.
- `hostSettings` holds entries to merge into a host's settings file
  (`.claude/settings.json`, `.codex/hooks.json`): a hook to register, a
  permission rule. The key is the file's path. Those files belong to the
  project, so the entries are merged in and the file is never written over:
  a key the project has keeps its value, a list gains the entries it lacks,
  a hook whose command is already registered is not added again, and
  nothing is removed. A second run changes nothing, and does not rewrite the
  file. A file that is not JSON, or that the host keeps read-only, is left
  alone, and the script says what is left to do. The merge cannot tell an
  entry the project removed from one that was never there: a later run adds
  it back.
- `firstRun` is a command to run once after installing, before `verify`. It
  is for an add-on whose verdict depends on something the installer changes:
  `format-lint` asks for its fixer, because a package scope of another length
  moves where an import line wraps.

A file under `.claude/`, `.codex/` or `.agents/` is in a host's own folder.
Codex's sandbox keeps the last two read-only, so that an agent cannot give
itself hooks or skills. When such a file cannot be written the rest of the
add-on still goes in, the file is not recorded, and the script says to run
it again outside the sandbox.

## Rules

1. **An add-on only adds.** New files, new scripts, new dev dependencies. It
   never edits a file the project already has, except `AGENTS.md` (its section),
   `package.json` files and a host's settings file (both through
   `addon.json`, and both by adding entries only). If something seems to need
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
