# Starter

A working project to start from: ports and adapters in a pnpm monorepo, a
streaming UI on RxJS and React, and the checks that keep it that way.

```bash
pnpm install
pnpm dev          # http://localhost:5173, on the in-browser simulator
pnpm dev:fs       # the server and the client together
pnpm gate:full    # everything CI runs
```

It contains one small feature, a live price list, built the way every feature
is meant to be built. [AGENTS.md](AGENTS.md) says where each kind of code goes
and lists the file that shows each pattern.

Packages export their TypeScript source. Nothing is compiled except the client,
which Vite bundles; the server and the tooling are run by Node directly.

The client's build runs the React Compiler, so its source has no `useMemo`,
`useCallback` or `memo`; `pnpm check:compiler` holds the compiler to what
relies on it.

This needs Node 26 or later. The floor is `devEngines.runtime` in
`package.json`, which pnpm enforces on install. It is not `engines.node`: a
host's build reads that field and refuses a range above the Node it offers.
`.nvmrc` holds the same number for a version manager.

pnpm is pinned in `package.json` too, as `packageManager`: an exact version
and the sha512 hash of that release, which Corepack checks the download
against. To move to another pnpm, run
`node tools/arch/ci/pin-package-manager.mts pnpm@<version> --write` and then
`pnpm install`. The `package-manager` gate fails when the hash is missing.

The checks live in `tools/arch` and are described in its README.

A project created from this folder does not get this file. Its README is
written from `scripts/templates/README.project.md`, with its own name, package
scope and add-ons.
