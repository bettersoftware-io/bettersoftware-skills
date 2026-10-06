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
| `pnpm lint:css` | `tools/repo-hygiene/check-css.mts` | Runs stylelint over every `.css` file, and fails on a warning too |
| syncpack settings | `tools/repo-hygiene/syncpack.json` | A starting file: written once, then the project's own |
| stylelint rules | `tools/repo-hygiene/stylelint.base.json` | Every rule in the table under "CSS". Belongs to the add-on: an update replaces it |
| The project's stylelint file | `tools/repo-hygiene/stylelint.json` | Only `extends` the base. A starting file: written once, then the project's own. A project adds, changes or switches off rules here |
| AGENTS section | `AGENTS.md` | When a version may differ, how to repair a link, where a colour goes, when a CSS rule may be turned off |

Five dev dependencies, in the root `package.json`: `@manypkg/cli` `^0.25.1`,
`syncpack` `^15.3.2`, `stylelint` `^17.13.0` and
`stylelint-declaration-strict-value` `^1.12.1`, as in the source repository
(its range for the last is `^1.11.1`), and `stylelint-config-standard`
`^40.0.0`, which is new here. Installed on 2026-10-06 they resolved to
0.25.1, 15.3.3, 17.16.0, 1.12.1 and 40.0.0. The newest release of each was
older than a day: stylelint 17.16.0 is from 2026-10-01, the plugin 1.12.1
from 2026-08-24, the standard config 40.0.0 from 2026-01-15.

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

`extends` and `plugins` in a stylelint file are found from the folder the
file is in, so the base beside it, `stylelint-config-standard` and the plugin
all resolve.

**Why JSON and not TypeScript.** stylelint 17.16.0 loads its config through
cosmiconfig 9, measured: given a `.mts` file it stops with `No loader
specified for extension ".mts"`. It does load a `.ts` file, by compiling it
and writing the result beside it as `<name>.ts.<uuid>.mjs` for the length of
the run. That is a JavaScript file in the project on every lint, and a `.ts`
file in `tools/` that the project's tooling typecheck (`tools/**/*.mts`) does
not read. JSON needs neither, so the rules stay in JSON and their reasons are
in this README, as with the Biome base. manypkg has
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

Each kind of finding carries the advice that fits it. Names that are out of
order are told to be put in order, and that no version changes:

```
FAIL versions

manypkg:
  @zeta/e2e's dependencies are unsorted, this can cause large diffs when packages are added, resulting in dependencies being sorted
    Put the names in each dependency map of that package.json in order. No version changes. The order is by character code, so every `@scope/…` name comes before a plain one, and `@types/…` before `@zeta/…`.
```

Until 2026-10-06 every failure ended with "Give every package the same
range", which says nothing about order. That sentence now follows a range
finding only. A kind of manypkg finding with no advice written for it says
so. The order finding itself came from this repository: a `package.json`
written for `@app` was out of order under a scope that sorts later, and the
installer now sorts after it renames.

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
- a file git ignores. Outside a git repository nothing is dropped for this;
- a hidden folder at the project root, other than `.github`, `.claude`,
  `.codex` and `.agents` (since 2026-10-06). It belongs to a tool: a
  plugin's working folder held notes whose links lead nowhere. A hidden
  folder further down is read. The CSS lint reads the same files.

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

A warning fails like an error. stylelint exits 0 on a rule set to
`"severity": "warning"`, so it would report on every run and stop nothing;
the wrapper passes `--max-warnings 0`, as the source's script does.

### The rules, with the reason for each

Two layers, as with the Biome base: `stylelint.base.json` belongs to the
add-on, and the project's `stylelint.json` extends it and wins.

| Rule | Reason |
|---|---|
| `stylelint-config-standard` | The floor: stylelint's own set of validity and notation rules. The source does not use it, because Biome judges the validity of its CSS. This add-on can be in a project without `format-lint`, where nothing else would |
| `color-no-invalid-hex`, `no-duplicate-selectors`, `no-invalid-double-slash-comments`, `no-irregular-whitespace`, `declaration-block-no-duplicate-custom-properties`, `font-family-no-missing-generic-family-keyword`, `function-linear-gradient-no-nonstandard-direction`, `string-no-newline` | The eight validity rules the source turns on by name. The standard set has them today; they are named so that they stay on whatever that set does later. Each is tested with a stylesheet that breaks it |
| `selector-class-pattern`: camelCase in `*.module.css` | The source's rule. A class in a CSS Module becomes a property of the imported object (`styles.priceRow`); a dash would need `styles["price-row"]` |
| `selector-class-pattern`: kebab-case in any other stylesheet | The standard set's own rule, with a message that names both cases |
| `custom-property-pattern`: kebab-case | Tokens are written `--color-up`. The source's rule and message |
| `scale-unlimited/declaration-strict-value` on every property whose name ends in `color`, and on `fill` and `stroke` | A colour is defined once, as a custom property, and used by name. A literal in a rule is a second place to change, and one a theme cannot reach |
| `reportDescriptionlessDisables`, `reportNeedlessDisables`, `reportInvalidScopeDisables` | A `stylelint-disable` comment needs ` -- ` and a reason, must switch off something that would report, and must name a rule that exists. Not in the source; it asked for this in words |

**What a colour may be.** `var(--name)` (with or without a fallback),
`currentcolor`, `transparent`, `inherit`, `initial`, `unset`, `revert`,
`revert-layer`, `none`, `auto`, and `color-mix()` of two of those:
`color-mix(in srgb, currentcolor 18%, transparent)`. Anything else fails: a
hex value, a named colour, `rgb()`, `hsl()`, and a `color-mix()` with a
literal in it. A custom property is where a literal is written, and the
plugin does not judge its value.

Different from the source's rule, on purpose:

| | In the source | Here | Why |
|---|---|---|---|
| Properties | `color`, `fill`, `stroke` | Those, and every property that ends in `color` (`background-color`, `border-color`, `outline-color`, …) | The source leaves backgrounds out because its existing tints would change with the theme if they became tokens. A new project has no such tints |
| Shorthands | Not read | `expandShorthand`: the colour in `border: 1px solid #ccc` and `background: linear-gradient(#fff, #000)` fails | The same literal, written another way |
| Functions | Any function passes, so `rgb(26 143 76)` does | `ignoreFunctions: false`, and `color-mix()` of tokens and keywords is allowed by pattern | A literal in a function is a literal |
| `resolveNestedSelectors` on the class pattern | On | Off | Measured with 17.16.0: `.row { &-stale {} }` in a CSS Module is not reported with it on. It is a Sass form that plain CSS nesting does not have, so the option changes nothing here |
| The override for one third-party stylesheet | Three kebab-case families for one file | Not there | That file is the source's. Here every stylesheet that is not a module is kebab-case already |

**The starter does not use CSS Modules.** It has one global stylesheet with
no class in it: it styles elements and `data-` attributes. So the source's
"class names are camelCase" would have judged nothing, and applied to a
global stylesheet it would be the wrong rule, since a global class is a
string in `className`, never a property. The decision: the rule means what
its reason says. camelCase where the class becomes a property
(`*.module.css`), kebab-case everywhere else.

**The starter's stylesheet was changed, not exempted.** Its two literal
colours are now `--color-up` and `--color-down` in `:root`, used as
`var(--color-up)`. The computed values are the same: `pnpm visual` passes on
the committed macOS goldens at a tolerance of zero, in a project with the new
stylesheet. The Linux goldens were not redrawn.

## How it was tested

Unit tests, run from this repository: `pnpm vitest run addons/repo-hygiene`,
129 tests in seven files. The link check runs against folders made for each
test; the two wrappers run against a stand-in for the installed tools, and
one test runs a real executable from a `node_modules/.bin`.
`tests/css-rules.test.mts` runs the real stylelint, through the wrapper,
with the two shipped config files: the starter's stylesheet and the visual
add-on's, one stylesheet per rule that breaks it, each kind of colour that
passes, the disable comments, the two layers. This repository has stylelint,
the standard config and the plugin as dev dependencies for that, in the
ranges of `addon.json`; a test fails when they differ.

Each test was turned red by a mutant of its own and restored
(`tests/mutants.json`, 130 of 130 killed; some tests have two). A first run
had one survivor: a test that a custom property's own value is not judged.
No setting can make it fail, because the plugin never reads a custom
property, so the test was removed and the fact is in the text above.

End to end, in a project made by `scripts/create-project.mts` and given the
add-on by `scripts/add-to-project.mts`, then `pnpm install`:

| Case | Result |
|---|---|
| The untouched starter, the add-on alone, by the steps of this repository's CI job (2026-10-06) | `check:versions` PASS (43 entries, 7 files), `check:doc-links` PASS (2 links, 3 files), `lint:css` PASS (1 stylesheet), `pnpm gate:full` exit 0 |
| A project with every add-on (2026-10-06) | all three PASS (50 entries; 4 links in 12 files; 2 stylesheets), `pnpm gate:full` exit 0, `pnpm visual` 5 of 5 on the committed macOS goldens |
| `rxjs` at `^7.8.1` in one package | `FAIL versions`, exit 1, both tools name the package |
| A link to a missing file, and two to anchors written by the simple rule (` -- `, `'`, `?`, `(v2.0)`) | `FAIL doc-links (3)`, exit 1, each with file and line, the anchors with the right one |
| `a { colr: red; }` | `FAIL css`, exit 1, `37:5 Unknown property "colr"` |
| A dead link, then `pnpm gate:fast` | exit 1 |
| `stylelint.json` removed; `extends` a package that is not there; `syncpack.json` not JSON | exit 2, "could not run", each with the reason |
| The only `.css` file moved away | `SKIP css`, exit 0 |
| A folder with no markdown | `SKIP doc-links`, exit 0 |
| The add-on added a second time | 0 files written, `git status` empty |
| A second project with `coverage`, `visual`, `performance` and this add-on | all three PASS (43 entries; 3 links in 4 files; 2 stylesheets), `pnpm gate:full` exit 0 |


The rows below are from the first version of the add-on (2026-10-05), when
the starter still had `currentColor` and literal colours; the starter has
since been changed and passes as it is.

Not tested: Linux; Windows; a run on GitHub.

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
- The token rule reads the properties it is given. A colour in
  `text-decoration`, `box-shadow` or a gradient outside `background` is not
  judged, and neither is the fallback in `var(--name, #fff)`.
- A project that took the add-on before the base existed keeps its own
  `stylelint.json`, which extends the standard set alone. Until 2026-10-06
  the new rules were then off there and `lint:css` passed: the demo ran
  that way. Now `lint:css` reads the project's file and fails when its
  `extends` does not name `./stylelint.base.json`, with what it extends
  and what to put there; and the update shows the two files side by side
  even when the project kept no earlier template. A project that wants a
  rule off extends the base and switches the rule off below it. The `strict-lint` add-on's `knip.jsonc` names both stylelint files
  for the same reason, and is the project's file too.
- The wrappers read what manypkg and syncpack print. A new major of either
  that changes its output (manypkg's `error` lines, `syncpack json`'s one
  object per line) would make `check:versions` exit 2, not pass.
