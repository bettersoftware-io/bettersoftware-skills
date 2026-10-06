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
  choice/<option>/files/   one set of starting files per option, when the add-on offers a choice
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
  "movedToProject": { "packages/client-react/tests/visual/host/main.tsx": { "to": "packages/client-react/tests/visual/seeding.ts", "note": "One sentence." } },
  "hostSettings": { ".claude/settings.json": { "permissions": { "ask": ["Bash(git push *--force*)"] } } },
  "choice": { "default": "dependabot", "options": { "dependabot": "One line.", "renovate": "One line." } },
  "requiresGates": ["playwright-pin"],
  "architecture": { "packages": { "packages/e2e": { "role": "e2e" } } },
  "verify": "pnpm coverage"
}
```

- `recommended` is true for an add-on a new project should take unless it has
  a reason not to. It decides what is selected to begin with when a person is
  offered the list, and what `create-project.mts --with recommended` adds.
- A `packageJson` key is a path from the project root. `packages/*` means every
  workspace package. A dependency is added in name order.
- A `package.json` among the add-on's files is written for the scope `@app`,
  with its dependencies in name order. In a project with another scope the
  installer puts them in order again after it renames the scope:
  `@zeta/shared` sorts after `@playwright/test`, and `@app/shared` before
  it. The creation script does the same for the starter's own packages.
  `scripts/dependency-order.test.mts` holds it for every add-on under three
  scopes.
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
  A starting file the project does not have is never passed over in silence.
  It is written when it is known to be new to the project, and named when
  that cannot be told:
  - `tools/installed.json` lists the starting files the project was given at
    the add-on's last update (`starting`), images included. A file the
    add-on ships that is not in that list is new: it is written. One that is
    in the list and gone was deleted by the project: it is left out, and
    nothing is said.
  - A record from before that list was kept cannot say. A text file is then
    new if its template is new to a project that keeps templates, and is
    written. Otherwise it is named under "Yours to change" with the `cp`
    that takes it; an image is named in one line under "Still to do by
    hand". It is not written, because a file the project deleted would come
    back: a golden of a scenario it removed fails the run as an orphan, a
    sample spec runs against a screen that is gone. It is said once.
  A starting file that differs from a template the project had no copy of is
  shown against the template, as "cannot be told which side changed"
  ([the kit's README](../kit/README.md) has the whole rule), and
  `add-to-project.mts <project> --compare <add-on>` lists every starting
  file that differs or is missing, at any time.
- `choice` is for an add-on that has two ways to do one job, of which a
  project has exactly one: one update bot or another. See "A choice" below.
- `verify` is the one command that proves the add-on works in a project that
  has just received it.
- `hostSettings` holds entries to merge into a host's settings file
  (`.claude/settings.json`, `.codex/hooks.json`): a hook to register, a
  permission rule. The key is the file's path. Those files belong to the
  project, so the entries are merged in and the file is never written over:
  a key the project has keeps its value, a list gains the entries it lacks,
  a hook the host would already run where the add-on needs it is not added
  again (its group's matcher covers the add-on's as that host reads a
  matcher, and its entry is a plain command hook with exactly that command
  line: `scripts/lib/hook-registration.mts`), and
  nothing is removed (but see `retiredHookCommands`). A second run changes nothing, and does not rewrite the
  file. A file that the host keeps read-only is left alone, and the script
  says what is left to do. The merge cannot tell an entry the project removed
  from one that was never there: a later run adds it back.
  A file that sets `disableAllHooks` runs no hook at all. The merge leaves
  that value, lists it under "Not merged", and exits 3.
  **What could not be merged is never silent.** A file that is not JSON, and
  a place where the project's file holds a value of another kind than the
  add-on needs (`"permissions": null`, `"ask": "Bash(x)"`,
  `"PreToolUse": {}`), keep the project's value. The summary then lists each
  such place under "Not merged", with the entries left out, and
  `add-to-project.mts` exits 3: the add-on's files are in, and the add-on is
  not whole.
- `retiredFiles` names a file an older version of the add-on had the project
  own and no longer reads, with a sentence for the person (`note`) and, when
  there is one, the starting file that took its place (`replacedBy`). While
  the old file is in the project every update says so, and writes the new
  starting file if the project does not have it. A setting is never left
  silently unread.
- `movedToProject` names a file of the add-on that projects had to edit, with
  the starting file where those edits go now (`to`) and a sentence that says
  what belongs there (`note`). The add-on still owns the file. A project that
  edited it is refused, as for any edited file, and the refusal says under
  the file's name where the edits go and what `--force` will do. Under
  `--force` the project's version is kept as
  `tools/templates/<add-on>.replaced.<path>.txt` before the file is
  replaced, and the summary says to move the lines over and delete the copy;
  every later update says so again while the copy is there. A manifest whose
  `to` is not a starting file is refused before anything is written.
- `retiredHookCommands` names a command line an older version registered for
  a hook, with the command line `hostSettings` registers now. Without it an
  update would add the new line beside the old one, and the hook would run
  twice. It is the one place where the merge changes what a project has, so
  it is bound on every side:
  - The value must be a command line this manifest registers under `hooks`
    in `hostSettings`, and the key must not be one. A manifest that breaks
    either is refused before anything is written. So the field cannot put a
    command into a project that the add-on does not already register, and
    cannot take out a hook it still wants.
  - A project's command is rewritten only when it is the key letter for
    letter, in a file and under an event where the manifest registers the
    value. It is rewritten where it stands. Only the command changes: the
    entry's timeout, its group, the group's matcher and the other hooks of
    the group stay. No group is ever taken out.
  - One thing is taken out: when the rewrite leaves the same entry twice in
    one group, equal in every field, the later one goes.
  - A command that only begins like the new line is left alone, the new line
    is added beside it, and the summary names it under "Still to do by hand".
  - The settings file is replaced in one step (a new file takes its place),
    so no reader sees it without the hook, and a failed write leaves it as it
    was. A file its owner made read-only is not replaced.
- `firstRun` is a command to run once after installing, before `verify`. It
  is for an add-on whose verdict depends on something the installer changes:
  `format-lint` asks for its fixer, because a package scope of another length
  moves where an import line wraps.

- `requiresGates` names gates the project's copy of the kit must have. An
  add-on that relies on a gate, or on a role that came with one, is refused by
  a project whose kit is older: nothing is written, and the message gives the
  command that brings the kit up to date. The project's
  `tools/arch/gates/gates.json` is what is read.
- `architecture.packages` declares the workspace packages the add-on brings
  in the project's `architecture.config.mts`, each with its role. The file
  belongs to the project, so an entry is added to its `packages` map and
  nothing else is touched: a package the project has already declared keeps
  its declaration, and a second run changes nothing. A file with no
  `packages: { … }` map the script can add to is left alone, and the script
  says which line to add by hand. The package itself is a starting file (its
  `package.json`, its source), so the project owns it from the first day.

## Paths the installer reads

A path the installer writes or removes has always gone through
`assertInside`: relative, no `..`, and no link anywhere on the way. Since
2026-10-06 a path it reads does too, through helpers beside it in
`scripts/lib/install.mts` (`projectHas`, `readProjectFile`,
`listProjectFolders`). The installer compares a project's own files with
templates and prints the difference, so what it reads can reach a screen.

- A file of the project that is a link, or is reached through one, is never
  opened. An update that would compare it stops before anything is written;
  `--compare` lists it as `refused`.
- A unit's name is checked to be lower-case letters, digits and dashes
  before it is joined into a path, and an option must be one the add-on
  offers, whether it comes from the command line or from the project's
  record.
- A template's copy has a flat name (`tools/templates/<unit>.<path with __
  for />.txt`). The name is only ever made from a path, never read back
  into one, so no name can point outside. Two starting files that would
  share a name are refused.
- What is printed from a project's file is text only: a file with a zero
  byte or larger than 512 KB is not shown, a difference is cut at thirty
  lines, a line at 300 characters, and every control character is written
  out (`\x1b`).

`scripts/project-paths.test.mts` reads these scripts' own source and fails
when one opens a project path any other way.

## A choice

```bash
node scripts/add-to-project.mts <project> ci-security:renovate
node scripts/create-project.mts <target> --with coverage,ci-security:renovate
```

An option is a set of starting files, in `choice/<option>/files/`, laid out
as `files/` is. `choice.options` gives each option one line that says what it
is, and `choice.default` names the one a project gets when none is asked
for. A project has one option at a time, and `tools/installed.json` records
which.

| Command | What the project gets |
|---|---|
| `<add-on>`, first time | The default option's files |
| `<add-on>:<option>`, first time | That option's files, and no other option's |
| `<add-on>`, later | An update. The option the project has is kept |
| `<add-on>:<other>`, later | The other option's files are written. Each file of the option it leaves is removed if the project never changed it. One it changed is left where it is, and the script says to move the changes over and delete it |

"Never changed" means the file is equal to the copy in `tools/templates/`,
which is the file as it was installed. A file with no such copy (an image, or
a project from before templates were kept) is left, and the script says it
could not tell.

An option changes starting files and nothing else: no script, no dependency,
no gate, no section of `AGENTS.md`. Those are the same for every option, so
the add-on's own text must hold for each of them. That is the whole
mechanism, and it is this small on purpose. The other design that was
weighed is a second add-on that replaces a file of the first. It needs a way
to remove an add-on to go back, which nothing here has, and a rule between
two add-ons; a choice inside one add-on needs neither.

Do not add an option for a difference a project can make by editing a
starting file. An option is for two files that must not both exist.

A file under `.claude/`, `.codex/` or `.agents/` is in a host's own folder.
Codex's sandbox keeps the last two read-only, so that an agent cannot give
itself hooks or skills. When such a file cannot be written the rest of the
add-on still goes in, the file is not recorded, and the script says to run
it again outside the sandbox.

## Rules

1. **An add-on only adds.** New files, new scripts, new dev dependencies. It
   never edits a file the project already has, except `AGENTS.md` (its section),
   `package.json` files, a host's settings file and the `packages` map of
   `architecture.config.mts` (all three through `addon.json`, and all by
   adding entries only). If something seems to need
   an edit, find the way that does not: a command-line flag, a new config file
   that extends the old one, a workflow file of its own. It removes one kind
   of file: a starting file of an option the project moves away from, and
   only when the project never changed it.
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
