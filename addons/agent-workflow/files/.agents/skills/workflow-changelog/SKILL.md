---
name: workflow-changelog
description: Use when asked to write or update a week's entry in CHANGELOG.md, or when an issue titled "Changelog: write <week>" is to be closed. Do not use for release notes of a published package.
---

# Changelog

The steps are in `.claude/commands/workflow/changelog.md`, at the project
root. Read that file and follow it from step 1.

It is written as a Claude Code command, so two things in it do not apply
here:

- Ignore the block between the `---` lines at its top.
- `$ARGUMENTS` is not filled in. The week is whatever the request names.
