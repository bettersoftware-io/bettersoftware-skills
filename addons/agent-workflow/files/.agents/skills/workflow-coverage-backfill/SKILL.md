---
name: workflow-coverage-backfill
description: Use when asked to find files with untested code, to close coverage gaps, or to raise a file's coverage. Needs the coverage add-on; the steps stop and say so without it.
---

# Coverage backfill

The steps are in `.claude/commands/workflow/coverage-backfill.md`, at the
project root. Read that file and follow it from step 0.

It is written as a Claude Code command, so two things in it do not apply
here:

- Ignore the block between the `---` lines at its top.
- `$ARGUMENTS` is not filled in. The packages are whatever the request names.
