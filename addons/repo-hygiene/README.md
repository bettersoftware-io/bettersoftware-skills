# Add-on: repo hygiene

Three small checks that keep a repository from drifting: one version of each
dependency across the workspace, no dead link or anchor in the markdown, and
lint for the stylesheets. Each takes seconds, needs nothing beyond
`pnpm install`, and joins `gate:fast`.

```bash
node scripts/add-to-project.mts <project> repo-hygiene
cd <project> && pnpm install && pnpm check:versions && pnpm check:doc-links && pnpm lint:css
```

## What it adds

| Part | Where | What it does |
|---|---|---|
| `pnpm check:versions` | `tools/repo-hygiene/check-versions.mts` | Runs `manypkg check` and `syncpack lint`. Fails when two packages ask for different ranges of one dependency |
| `pnpm check:doc-links` | `tools/repo-hygiene/check-doc-links.mts` | Reads every markdown file. Fails a relative link to a file that is not there, and a `#anchor` the target file does not have |
| `pnpm lint:css` | `tools/repo-hygiene/check-css.mts` | Runs stylelint with `stylelint-config-standard` over every `.css` file |
| syncpack settings | `tools/repo-hygiene/syncpack.json` | A starting file: written once, then the project's own |
| stylelint rules | `tools/repo-hygiene/stylelint.json` | A starting file: written once, then the project's own |
| AGENTS section | `AGENTS.md` | When a version may differ, how to repair a link, when a CSS rule may be turned off |

Four dev dependencies, in the root `package.json`, with the ranges the source
repository uses: `@manypkg/cli` `^0.25.1`, `syncpack` `^15.3.2`, `stylelint`
`^17.13.0`, and `stylelint-config-standard` `^40.0.0` (new here). Installed on
2026-10-05 they resolved to 0.25.1, 15.3.3, 17.16.0 and 40.0.0.

There is no workflow file. The three commands are in `gate:fast`, which the
project's own CI job and the agent's stop hook already run.

Every check prints one of `PASS` (with how much it judged), `SKIP` (with the
reason) or `FAIL`, and exits 0, 0 or 1. It exits 2 when it could not run: a
tool is not installed, a settings file is missing or unreadable, a tool
crashed.

## No JavaScript config file

The project's `typescript-only` gate allows no `.js`, `.mjs` or `.cjs` file,
and both tools usually take one. Both also take a JSON file by path:

- `syncpack lint --config tools/repo-hygiene/syncpack.json`
- `stylelint --config tools/repo-hygiene/stylelint.json`

`extends` in the stylelint file is found from the folder the file is in, so
`stylelint-config-standard` resolves from the root `node_modules`. manypkg has
no settings file; its options live in a `manypkg` field of the root
`package.json`, which an add-on cannot write. That is why one of its rules is
filtered in the wrapper instead (see below).

## Versions

```
FAIL versions

manypkg:
  @app/server has a dependency on rxjs@^7.8.1 but the most common range in the repo is ^7.8.2, the range should be set to ^7.8.2

syncpack:
  = Default Version Group ========================================================
     4x rxjs
        ✘ ^7.8.1 → ^7.8.2 in packages/server/package.json at .dependencies (DiffersToHighestOrLowestSemver)
  ✗ Issues found
```

`syncpack.json` ships with one version group. It ignores the workspace's own
packages (`$LOCAL`): they depend on each other as `workspace:*` and have no
`version` field, and syncpack reports both as errors by default (22 findings
in the untouched starter).

syncpack does not stop at a settings file it cannot parse. It goes on with its
defaults and reports the 22 findings above. The wrapper parses the file first
and exits 2.

`SKIP` when no `package.json` has a dependency.

## Links

```
FAIL doc-links (2)
  README.md:23
    The link `docs/setup.md` leads to docs/setup.md, which does not exist. Correct the path, or remove the link.
  README.md:23
    The link `docs/guide.md#local-ci` names the anchor `#local-ci`, and docs/guide.md has no heading with that anchor. It has `#local----ci`: GitHub lowers the case, drops punctuation and turns every space into a dash, so `A -- B` is `#a----b`.
```

The anchor is the reason this check exists. GitHub's rule is not "lower case,
spaces to dashes": a character it drops leaves the spaces around it behind. A
link written from the simple rule is dead, and nothing says so until a reader
clicks it.

**The slug rule is github-slugger's, copied.** `lib/slug.mts` holds the
algorithm and the character table of `github-slugger` 2.0.0 (ISC licence,
kept in the file). It is not a dependency: the check then needs nothing
installed, and this repository's tests need no new package. The copy was
compared with the real package on every Unicode code point (1,112,064 of
them, in the form `A <char> B`) and on a sequence of repeated headings: no
difference. The table was written into the file by a script, not by hand.

Which files it reads: every `.md` file, except

- installed and generated folders (`node_modules`, `dist`, `coverage`,
  `reports`, `.git`, `.turbo`, `.vite`, `.next`, `.expo`, `.cache`);
- **`tools/` at the root.** That folder is the installed kit and add-ons. The
  project does not own those files, and the kit's docs there have four
  links that are dead by design in a project: two in `tools/arch/README.md`
  (`architecture.config.example.mts`, `../docs/small-model-2026-10-05.md`) and
  two in `tools/arch/docs/handler-naming.md`. They point at files of this
  repository, or of the one the kit came from, that are not copied. A link *into* `tools/` from the project's own docs is
  still checked. A folder called `tools` deeper down is read;
- a folder that is a checkout of its own (it has a `.git`): a git worktree, a
  nested clone;
- a file git ignores. Outside a git repository nothing is dropped for this.

What it reads in a file: `[text](target)` with or without a title, images,
`[label]: target` definitions, and `href`/`src` in HTML. Not what is inside a
fenced block or a code span. An anchor is a heading (`#` style or underlined),
made from the words a reader sees (a link gives its text, emphasis loses its
marks), numbered `-1`, `-2` when repeated, or an `id`/`name` written in HTML.

Beyond the source checker it also: fails a link whose name differs from the
file's only by case (it opens on macOS and is dead on GitHub and in CI); reads
a path that starts with `/` from the project root; reads every markdown file
instead of a fixed list of folders.

`SKIP` when there is no markdown file, or no relative link in any.

## CSS

stylelint's own report is printed under `FAIL css`: the file, the line, the
column, the rule.

The wrapper exists because stylelint alone cannot say "nothing to lint".
Measured with 17.16.0: given a pattern that matches no file it stops with
`NoFilesFoundError` (exit 1), and with `--allow-empty-input` it exits 0 and
prints nothing. The wrapper lists the files itself, with the same exclusions
as the link check, and prints `SKIP css` when there are none. stylelint's exit
2 is a finding; any other non-zero exit (78 for a bad configuration) is
"could not run", exit 2.

The rules are `stylelint-config-standard`, unchanged. A project that uses CSS
Modules will want camelCase class names, which the standard set rejects
(`selector-class-pattern` asks for kebab-case): change that rule in
`stylelint.json`. The source repository does not use the standard set at all,
because Biome formats its CSS; a project that adds the `format-lint` add-on
may want to turn off the rules the two share.

## How it was tested

Unit tests, run from this repository: `pnpm vitest run addons/repo-hygiene`,
86 tests in six files. The link check runs against folders made for each
test; the two wrappers run against a stand-in for the installed tools, and
one test runs a real executable from a `node_modules/.bin`. Each of the 86
tests was turned red by a mutant of its own (`tests/mutants.json`, 86 of 86
killed) and restored.

End to end, in a project made by `scripts/create-project.mts` and given the
add-on by `scripts/add-to-project.mts`, then `pnpm install`:

| Case | Result |
|---|---|
| The untouched starter | `check:versions` PASS (38 entries, 7 files), `check:doc-links` PASS (1 link, 3 files), `lint:css` **FAIL**: `currentColor` in the starter's `index.css` (see below) |
| With that one word changed in the project | all three PASS, `pnpm gate:full` exit 0 |
| `rxjs` at `^7.8.1` in one package | `FAIL versions`, exit 1, both tools name the package |
| A link to a missing file, and two to anchors written by the simple rule (` -- `, `'`, `?`, `(v2.0)`) | `FAIL doc-links (3)`, exit 1, each with file and line, the anchors with the right one |
| `a { colr: red; }` | `FAIL css`, exit 1, `37:5 Unknown property "colr"` |
| A dead link, then `pnpm gate:fast` | exit 1 |
| `stylelint.json` removed; `extends` a package that is not there; `syncpack.json` not JSON | exit 2, "could not run", each with the reason |
| The only `.css` file moved away | `SKIP css`, exit 0 |
| A folder with no markdown | `SKIP doc-links`, exit 0 |
| The add-on added a second time | 0 files written, `git status` empty |
| A second project with `coverage`, `visual`, `performance` and this add-on | all three PASS (43 entries; 3 links in 4 files; 2 stylesheets), `pnpm gate:full` exit 0 |

**The starter fails `lint:css` as it is.**
`starter/packages/client-react/src/index.css` line 22 has `currentColor`;
`stylelint-config-standard` wants `currentcolor` (`value-keyword-case`). Until
that word is changed in the starter, a new project that takes this add-on is
red at `gate:fast` until it runs `stylelint --fix` or edits the line.

Not tested: a project that also has the `format-lint` or `ci-security`
add-on; Linux; Windows; a run on GitHub.

## Limits

- The link check reads markdown by a few rules; it is not a parser. It does
  not resolve reference links by label (`[text][label]` is checked through its
  `[label]:` line only), and it does not know an indented code block from
  text. An underlined heading is recognised only after a blank line.
- An anchor is compared exactly. GitHub's own anchors are lower case; a link
  to `#Usage` is reported even where a browser would forgive it.
- Anchors are checked in `.md` targets only. `file.ts#L10` is checked for the
  file and not for the line.
- Headings are slugged as GitHub does it today. Another renderer (a docs site
  generator) may make other anchors.
- `https:` links are never followed.
- `lib/slug.mts` is a copy. If github-slugger changes its table, the copy does
  not follow until someone regenerates it.
- The CSS check reads `.css` only: no Sass, no Less, no styles in TypeScript.
- The wrappers read what manypkg and syncpack print. A new major of either
  that changes its output (manypkg's `error` lines, `syncpack json`'s one
  object per line) would make `check:versions` exit 2, not pass.
