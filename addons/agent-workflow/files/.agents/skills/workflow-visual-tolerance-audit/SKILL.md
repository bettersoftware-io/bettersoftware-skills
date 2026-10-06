---
name: workflow-visual-tolerance-audit
description: Use when asked whether the visual tests' tolerance is right, when a visual test fails with nothing changed, or before anyone changes tolerance.ts. Needs the visual add-on; the steps stop and say so without it.
---

# Visual tolerance audit

The steps are in `.claude/commands/workflow/visual-tolerance-audit.md`, at
the project root. Read that file and follow it from step 0.

It is written as a Claude Code command, so two things in it do not apply
here:

- Ignore the block between the `---` lines at its top.
- `$ARGUMENTS` is not filled in. The arguments are whatever the request names.
