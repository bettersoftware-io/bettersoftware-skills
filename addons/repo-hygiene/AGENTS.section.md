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

**CSS.** Fix what stylelint reports. Turn a rule off in
`tools/repo-hygiene/stylelint.json` only when the project as a whole does not
want it, never for one file that breaks it, and say why in the commit message.
Do not add a `stylelint-disable` comment without a reason after it. Skip this
for a change that touches no `.css` file.

Do not weaken a check to make it pass. If a finding looks wrong, say so.
