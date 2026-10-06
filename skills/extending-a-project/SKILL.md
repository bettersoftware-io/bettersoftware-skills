---
name: extending-a-project
description: Use when a project that has the architecture kit (a tools/arch folder and an architecture.config file) needs coverage gates and reports, visual golden tests or rendering-performance checks added, when its copy of the kit or of an add-on should be brought up to date, or when an existing project wants the architecture gates for the first time.
---

# Extending a project

Checks reach a project as files, put there by one script. Never copy them by
hand: the script records a hash of every file it installs, and that record is
what lets a later update replace an untouched file and refuse to overwrite one
the project has edited.

## Skip it when

- There is no project yet. Create one first (`creating-a-project`).
- The check asked for is not in the list below. Say so; do not improvise one.

## 1. Pick the unit

The script is `scripts/add-to-project.mts` at the root of the plugin this
skill ships in, which is two folders above this file. `--list` prints the
units it has now:

```bash
node <plugin root>/scripts/add-to-project.mts --list
```

| Unit | The project gains |
|---|---|
| `kit` | The architecture gates, lint rules and agent hooks in `tools/arch`. Run it again to update them |
| `coverage` | A per-file coverage gate, a ranked list of gaps, a mutation check, a published report |
| `visual` | Screenshot tests of the UI against committed golden images |
| `performance` | A static check of animations and transitions, a runtime motion audit, a guide |
| `agent-workflow` | A hook that keeps each push and pull request step in a call of its own, permission rules, a worktree script, a weekly tag, a checked changelog |

Adding a unit a project already has updates it.

If the script is not there (the skill was copied on its own), clone
`https://github.com/bettersoftware-io/skills` into a temporary folder and run
the script from the clone.

## 2. Start from a clean tree

Run `git status` in the project. If there are uncommitted changes, stop and
say so: the script's changes should be one reviewable diff.

## 3. Run the script

```bash
node <plugin root>/scripts/add-to-project.mts <project> <unit>
```

- If it stops and lists files that differ, it has changed nothing. Show the
  list. Pass `--force` only when the user says to: it overwrites their edits.
- If it prints "Still to do by hand", those steps are the user's to decide
  (which role each package plays, how to merge hook settings). Do them with
  the user, not for them.

## 4. Prove it

Run the lines the script prints under "Next", in order: `pnpm install`, the
unit's own check, then `pnpm gate:full`. All must pass. If a check fails on a
project that was passing before, report the output unchanged and stop; do not
edit the installed files to make it pass.

## 5. Report

1. What was written, removed and changed (the script's own summary).
2. The result of each command in step 4.
3. What is still to do by hand, if anything.
4. That the project's `AGENTS.md` now has a section for the unit, and that it
   is the place to read how to work with it.
