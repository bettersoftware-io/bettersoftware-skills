# Packaging the plugin, 2026-10-04

The repository became an installable plugin, `bettersoftware-skills`, for
Claude Code and Codex, and gained a second skill, `creating-a-project`. This is
what was checked, and what was not.

The plugin was called `inward` while these checks ran and was renamed
afterwards. The install checks were repeated under the new name; the three
agent runs were not, which is why run 2's prompt shows the old one.

## Installing

Each host was given its own empty configuration folder, so nothing here
touched a real setup. The marketplace was added from the local checkout first,
and again from GitHub (`bettersoftware-io/skills`) once it was pushed.

| Check | Result |
|---|---|
| `claude plugin validate .` (Claude Code 2.1.289) | Passes, with one warning: no `version`. That is deliberate, see below |
| Claude Code: add the marketplace, install `bettersoftware-skills@bettersoftware` | Installed and enabled. Two skills, no hooks, about 156 tokens added to every session |
| Codex 0.160.0: add the marketplace, add `bettersoftware-skills@bettersoftware` | Installed and enabled. Both skills are in its cache |
| Create a project with the script inside Codex's cache, install from the lockfile, run `gate:full` | Pass: five gates, 37 tests, build |
| Both hosts again, from GitHub | Installed and enabled on both |
| Create a project with the script inside Claude Code's cache of the GitHub install, install from the lockfile, run `gate:full` | Pass: five gates, 37 tests, build |
| The four manifests agree (`scripts/plugin-manifests.test.mts`) | 10 tests |

Two things were learned on the way:

- **Codex copies a plugin without its symlinks.** In the starter, `tools/arch`
  is a link to the kit; in Codex's cache that folder is empty. The creation
  script never relied on the link (it copies the kit itself), and the
  cache run above is the proof.
- **The two hosts version differently.** With no `version` in its manifest,
  Claude Code names the installed version after the commit, so every commit
  reaches users. Codex names its cache folder after the manifest's `version`
  (`0.1.0`), so the Codex manifest keeps one, to be raised on a release.

## The creation skill

Without it, an agent asked for a new project writes one by hand. The
[baseline run](baseline-2026-10-04.md) is that case: three tasks in an empty
folder produced a project with 19 gate findings and none of the checks.

With it, three headless runs (`claude -p`, Claude Opus 5.5, the plugin loaded
from the checkout, the user's other plugins loaded too):

| | 1. Plain request | 2. Called by name | 3. Folder already holds a project |
|---|---|---|---|
| Prompt | "Start a new project for me in ./order-book: a live order-book viewer. I want TypeScript, clean architecture (ports and adapters) and a streaming UI on RxJS and React. Only set the project up now…" | `/inward:creating-a-project trade-blotter` | "Start a new project right here in this folder for a chat app…" |
| Skill loaded | Yes, unprompted | Yes | Yes, unprompted |
| What it did | Ran the script with `--scope @order-book --name order-book` | Ran the script with `--scope @trade-blotter --name trade-blotter` | Created nothing, changed nothing, and said why |
| `gate:full` on the untouched project | Pass, 37 tests | Pass, checked by exit code | Not applicable |
| First commit | Not made: the session was not allowed `git add`. It said so and gave the command | Made, 104 files | Not applicable |
| Report | All four parts | All four parts | Offered the two ways forward |
| Time and cost | 48 s, $0.63 | 57 s, $0.64 | 39 s, $0.50 |

One change came out of run 1: its report listed the commands but could not say
what `pnpm dev:fs` does, because the skill had not told it. The skill now
states what each command does, and run 2 reported them correctly.

## Not checked

- **An agent session in Codex.** Installing was checked; whether Codex loads
  the skills at the right moment, and finds the script two folders above the
  skill, was not. It needs a Codex login.
- **The other skip case**, a request for a stack the starter does not fit.
- **Other models.** All three runs used one model.
