# bettersoftware-skills

Plugins for Claude Code and Codex that encode one way of building TypeScript
applications: clean architecture in a pnpm monorepo, a streaming UI on RxJS,
and a testing approach that proves the tests can fail.

The rules here were not designed up front. They were extracted from a real
codebase, [ReactiveTraderCloudClone](https://github.com/bettersoftware-io/ReactiveTraderCloudClone),
where each one exists because something went wrong without it.

## Install

One plugin exists so far, `bettersoftware-skills`, in a marketplace called
`bettersoftware`.

Claude Code:

```
/plugin marketplace add bettersoftware-io/skills
/plugin install bettersoftware-skills@bettersoftware
```

Codex:

```bash
codex plugin marketplace add bettersoftware-io/skills
codex plugin add bettersoftware-skills@bettersoftware
```

| Skill | Use it |
|---|---|
| `bettersoftware-skills:creating-a-project` | To start a new project from the starter. It runs the script, installs, and proves `gate:full` passes before anything is changed |
| `bettersoftware-skills:reviewing-architecture` | To review a change for what no gate can check, as seven judgement questions |

The plugin installs no hooks. The gates and the hooks that run them are files
in each project (`tools/arch`, `.claude/settings.json`, `.codex/hooks.json`),
so they apply to everyone who works on the project, with or without the
plugin, and to CI.

The Claude Code manifest carries no `version` on purpose: a version pins
users until it changes, and while the plugin is this young every commit should
reach them.

## What is in this repository

- [`starter/`](starter/README.md): a working project to start from, with one
  small feature built the way every feature is meant to be built. Without the
  plugin, create a project from it with
  `node scripts/create-project.mts <target> --scope @acme`.
- [`kit/`](kit/README.md): the deterministic checks (architecture gates, lint
  rules) and the agent hooks that run them. Tested, and proven against a
  baseline run.
- [`skills/`](skills): the two skills above.
  [How the review was tested](docs/review-skill-test-2026-10-04.md);
  [how the plugin was tested](docs/plugin-test-2026-10-04.md).
- [`docs/starter-test-2026-10-04.md`](docs/starter-test-2026-10-04.md): two
  features built by an agent in a project created from the starter.
- [`docs/inventory.md`](docs/inventory.md): what is being extracted, and how it
  is sorted.
- [`docs/baseline-2026-10-04.md`](docs/baseline-2026-10-04.md): what an agent
  built with no guidance, and what the kit says about it.

## Planned plugins

| Plugin | Contents |
|---|---|
| `bettersoftware-skills` (exists) | The starter and its creation skill, the gate kit, the review. Skills for placing logic, adding a port, streaming state and testing are written only when a task fails in a way the gates do not catch; none has yet |
| Coverage and reports | Coverage gates, per-file gap ranking, published coverage and failure reports |
| Visual goldens (optional) | Scenario matrix, golden sets, update runbook, tolerance audit, diff report |
| Rendering performance (optional) | Compositor-only animation rules and the motion audit |

## Principles

- **Everything checkable is checked.** A rule a machine can verify gets a
  deterministic check, whether or not an agent tends to follow it unprompted.
  One good run proves nothing about the next.
- **Skills carry what a machine cannot check.** Judgement calls, reasons and
  fix recipes. The baseline run decides what skill text is worth its context;
  it never decides what gets enforced.
- **The failure message does the teaching.** A check says what is wrong and
  where the code belongs, at the moment the rule is broken.
- **Nothing to judge is not a pass.** A check that could not run, or found
  nothing to look at, says so.
- **Every rule says when to skip it.** A rule without a stated exception gets
  applied where it does not belong.
- **Keep the door open, don't build the room.** Replaceability comes from
  cheap bans on the wrong imports, not from abstractions written in advance.

## Licence

MIT
