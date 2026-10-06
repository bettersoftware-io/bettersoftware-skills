## CI security

Three workflows check the supply chain on GitHub: `CI security` (workflow lint
and `pnpm audit --prod`), `Dependency Review` and `Scorecard`. They need the
network, so none of them is in `pnpm gate:full`. `pnpm check:dockerfiles`
needs none and is in `gate:fast`. This section is what they cannot decide.

```bash
pnpm lint:workflows              # actionlint (valid?) then zizmor (safe?)
pnpm lint:workflows zizmor       # one of them
pnpm check:dockerfiles           # images by digest, no root, no package outside a lockfile
```

Exit 0 is a pass. Exit 1 is a finding, named in the linter's output above the
`FAIL` line. Exit 2 with a `SKIP` line means the lint did not run here (no
network on the first run, no build for this machine, a wrong checksum). Report
a `SKIP` as "not run". Never report it as a pass, and do not retry in a loop: a
sandbox with no network will not get one.

### When you add or change a workflow

Run `pnpm lint:workflows` before you commit. Skip it only when no file under
`.github/` changed. In a new workflow:

- Pin every action by its full commit hash, with the version in a comment
  after it. Take the hash from the action's release, not from memory.
- Give the workflow `permissions: contents: read`. Grant a write on the one job
  that needs it, with a comment that says why.
- Write `persist-credentials: false` on every checkout, unless that job pushes.
- Put no `${{ … }}` expression in a `run:` line. Pass the value through `env:`
  and quote the variable.
- Do not use `pull_request_target` or `workflow_run`. If the task seems to need
  one, stop and ask the user.

Do not silence a finding with `# zizmor: ignore[…]`, a `zizmor.yml` or an
`actionlint.yaml` to turn the run green. Fix the workflow. If you believe a
finding is wrong, say so and leave it red.

### When Dependency Review fails a pull request

Its job summary names the package and the advisory or licence.

- **An advisory:** move to the patched version it names. If the package came
  in through another one, update that one, or add a pnpm `overrides` entry
  that lifts only the vulnerable package, with a comment that names the
  advisory.
- **No patched version exists:** do not add the dependency. If it is already
  on main, tell the user; they decide whether to accept it.
- **A refused licence** (GPL, AGPL, SSPL): do not add the package. Find
  another. A package offered under two licences, one of them permissive, is
  the user's decision, not yours.

Never loosen `fail-on-severity`, `fail-on-scopes` or `deny-licenses` to pass.

### When `pnpm audit --prod` fails

The same steps as an advisory above. The weekly run can fail with no change in
the project: an advisory was published for a version already in the lockfile.

### When you add or change a Dockerfile

Run `pnpm check:dockerfiles`. Skip this when no Dockerfile changed.

- Take a digest from the registry
  (`docker buildx imagetools inspect <image>:<tag>`), never from memory, and
  keep the tag in front of it for the reader. The same for an image in
  `COPY --from=` and in `RUN --mount=…,from=`.
- Write the image and the user out. A variable in either fails, whatever its
  default: `FROM ${BASE}`, `USER ${APP_USER}`.
- End the last stage with `USER` and a plain name or number that is not root.
- Write a heredoc as `<<EOF` on a line with no quotes, and put the script in
  its body.
- "Nothing else in this file was judged" means the check could not read the
  file as Docker does. Fix that line first, then run it again: the other
  findings come after.

Do not get past a finding by another spelling, by moving the Dockerfile, or
by a `--build-arg` or `--target` on the command line. If you believe a finding
is wrong, say so and leave it red.

### The update bot

The project has one update bot, Dependabot or Renovate, and its config is the
one file for it in `.github/`. Never add a config for the other by hand: two
bots open the same pull requests twice. To
move from one to the other, tell the user; it is one command in the
repository the add-on came from, and Renovate needs its GitHub App installed
by a person. Do not shorten the release age in either file to get an update
sooner.

### `SECURITY.md`

It is the project's own text. Change it only when the user asks, and keep
its promises (the answer time, the disclosure time) ones the user chose.

### Moving a linter to a newer release

`tools/ci-security/lib/pins.mts` holds the version, four URLs and four
checksums of each linter, and its first lines give the command that prints the
checksums. Change all of them together. If a download is refused for a wrong
checksum, never copy the new checksum into the file to make it pass: tell the
user.
