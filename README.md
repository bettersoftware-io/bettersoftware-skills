# bettersoftware-skills

Claude Code plugins that encode one way of building TypeScript applications:
clean architecture in a pnpm monorepo, a streaming UI on RxJS, and a testing
approach that proves the tests can fail.

The rules here were not designed up front. They were extracted from a real
codebase, [ReactiveTraderCloudClone](https://github.com/bettersoftware-io/ReactiveTraderCloudClone),
where each one exists because something went wrong without it.

## Status

Early. Nothing is installable yet. The repository currently holds the
[inventory](docs/inventory.md) of what will be extracted and how it is sorted.

## Planned plugins

| Plugin | Contents |
|---|---|
| Core | Placing logic; adding a port and adapter; streaming state; testing; adding a package or boundary; a scaffold command; the enforcement templates |
| Coverage and reports | Coverage gates, per-file gap ranking, published coverage and failure reports |
| Visual goldens (optional) | Scenario matrix, golden sets, update runbook, tolerance audit, diff report |
| Rendering performance (optional) | Compositor-only animation rules and the motion audit |

## Principles

- **Enforcement over advice.** A skill explains a rule; a dependency-cruiser
  rule, a lint rule or a CI gate is what keeps it true. Templates come first.
- **Only what the model gets wrong.** Before a skill is written, the same task
  is run without it. Anything the model already does reliably is left out.
- **Every rule says when to skip it.** A rule without a stated exception gets
  applied where it does not belong.
- **Keep the door open, don't build the room.** Replaceability comes from
  cheap bans on the wrong imports, not from abstractions written in advance.

## Licence

MIT
