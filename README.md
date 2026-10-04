# bettersoftware-skills

Claude Code plugins that encode one way of building TypeScript applications:
clean architecture in a pnpm monorepo, a streaming UI on RxJS, and a testing
approach that proves the tests can fail.

The rules here were not designed up front. They were extracted from a real
codebase, [ReactiveTraderCloudClone](https://github.com/bettersoftware-io/ReactiveTraderCloudClone),
where each one exists because something went wrong without it.

## Status

Early. No plugin is installable yet. What exists:

- [`starter/`](starter/README.md): a working project to start from, with one
  small feature built the way every feature is meant to be built. Create a
  project from it with `node scripts/create-project.mts <target> --scope @acme`.
- [`kit/`](kit/README.md): the deterministic checks (architecture gates, lint
  rules) and the agent hooks that run them. Tested, and proven against a
  baseline run.
- [`skills/reviewing-architecture`](skills/reviewing-architecture/SKILL.md): the
  review of what no gate can check, as seven judgement questions.
  [How it was tested](docs/review-skill-test-2026-10-04.md).
- [`docs/starter-test-2026-10-04.md`](docs/starter-test-2026-10-04.md): two
  features built by an agent in a project created from the starter.
- [`docs/inventory.md`](docs/inventory.md): what is being extracted, and how it
  is sorted.
- [`docs/baseline-2026-10-04.md`](docs/baseline-2026-10-04.md): what an agent
  built with no guidance, and what the kit says about it.

## Planned plugins

| Plugin | Contents |
|---|---|
| Core | Placing logic; adding a port and adapter; streaming state; testing; adding a package or boundary; a scaffold command; the enforcement templates |
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
