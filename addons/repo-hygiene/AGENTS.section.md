## Repo hygiene

Three checks run in `gate:fast`: `pnpm check:versions`, `pnpm check:doc-links`
and `pnpm lint:css`. Each fails with the file and what to change. What they
cannot decide is below.

**Versions.** When you add a dependency a second package already has, copy
that package's range. When the check fails, change the ranges to agree; do not
add a version group to get past it. A version group in
`tools/repo-hygiene/syncpack.json` is for a difference the project wants (two
majors during a migration), and its `label` says why and until when. Skip
this when the project has one package.

**Links.** When you rename a heading, move a file or delete a document, run
`pnpm check:doc-links` before you commit, and repair each link it names:
point it at the new place. Remove a link only when what it pointed to is gone
for good. Do not work out an anchor in your head. GitHub drops punctuation and
keeps the spaces around it, so `## A -- B` is `#a----b`; the check prints the
anchor the file really has. It does not follow `https:` links, and it does not
read `tools/`. Those are yours to check by reading. Skip this for a change
that touches no markdown.

**CSS.** Fix what stylelint reports. A colour is written once, as a custom
property where the project's other tokens are (`:root` in the client's
`src/index.css`), and used as `var(--name)`. Before you add a token, look for
one that already means the same thing, and name a new one for what it means
(`--color-up`), not for how it looks (`--green`). A class is camelCase in a
`*.module.css` file and kebab-case in any other stylesheet. Turn a rule off
in `tools/repo-hygiene/stylelint.json` only when the project as a whole does
not want it, never for one file that breaks it, and say why in the commit
message. Do not edit `stylelint.base.json`: an update of the add-on replaces
it. A `stylelint-disable` comment needs ` -- ` and the reason after the rule's
name; use one only for a line that is a true exception. Skip this for a
change that touches no `.css` file.

Do not weaken a check to make it pass. If a finding looks wrong, say so.
