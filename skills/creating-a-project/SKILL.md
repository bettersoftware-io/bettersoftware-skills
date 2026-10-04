---
name: creating-a-project
description: Use when starting a new TypeScript application or monorepo that should be built on ports and adapters with a streaming UI (RxJS, React) — the user asks for a new project, app, starter or scaffold of that kind, and the target folder holds no project yet.
---

# Creating a project

A project is created by a script, never written by hand. The script copies
files that were tested together: six packages holding one feature built the
way every feature is meant to be built, the architecture gates, the lint
rules, the agent hooks, the CI workflow and the lockfile. A project written
from scratch has none of the checks, and the checks are the point.

## Skip it when

- The target folder already holds a project. This skill only creates new
  ones: say so and stop.
- The user wants another stack: not TypeScript, not a pnpm monorepo, or a
  framework that owns the project layout (Next.js, Expo Router). Say the
  starter does not fit, and stop.

## 1. Settle three values

Ask only for what the request does not already say.

| Value | Rule | When the user gave none |
|---|---|---|
| Target folder | Empty, or not there yet | Ask |
| Package scope | `@` then lower-case letters, digits, dashes | `@` + the project name |
| Project name | Lower-case letters, digits, dashes | The target folder's name |

## 2. Check the tools

`node --version` is 24 or later, and `pnpm --version` answers. If either
fails, report which and stop: the project's tooling is TypeScript that Node
runs directly, and an older Node cannot.

## 3. Run the script

The script is `scripts/create-project.mts` at the root of the plugin this
skill ships in, which is two folders above this file.

```bash
node <plugin root>/scripts/create-project.mts <target> --scope @acme --name my-app
```

If the script is not there (the skill was copied on its own), clone
`https://github.com/bettersoftware-io/skills` into a temporary
folder and run the script from the clone.

## 4. Prove the project before changing it

In the target folder, in this order:

```bash
git init
pnpm install
pnpm gate:full
```

`gate:full` must pass on the untouched project. If it fails, the starter is at
fault: report the output unchanged and stop. Do not edit the project to make
it pass.

Make the untouched project the first commit, unless the user has said not to
commit. A clean first commit keeps the first feature's diff readable.

## 5. Report

Say, in this order:

1. Where the project is, and that `gate:full` passed (or its output, if not).
2. The commands: `pnpm dev` (the client on the in-browser simulator, no
   server), `pnpm dev:fs` (the server and the client together),
   `pnpm gate:fast` (gates, lint, typecheck) and `pnpm gate:full` (the same,
   then tests and the build: what CI runs).
3. That `AGENTS.md` in the project says where each kind of code goes, and that
   the price list is a worked example to copy, not part of the product.
4. That the hooks are in the project, so they apply to everyone who works on
   it: Claude Code reads `.claude/settings.json`; Codex reads
   `.codex/hooks.json` once it is trusted with `/hooks`.

Features come after the report, as their own work.
