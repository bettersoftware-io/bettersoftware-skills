# {{name}}

A TypeScript monorepo built on ports and adapters, with a streaming UI on RxJS
and React, and the checks that keep it that way.

## First

```bash
{{first}}
```

`pnpm gate:full` passes on the project as it was created. Run it before the
first change, so a later failure is known to come from the change.

## Every day

```bash
pnpm dev          # http://localhost:5173, on the in-browser simulator
pnpm dev:fs       # the server and the client together
pnpm gate:fast    # architecture gates, lint, typecheck
pnpm gate:full    # gate:fast, then tests and the build: everything CI runs
pnpm gate:full:quiet   # the same commands and verdict, printing only the stage that failed
pnpm --filter {{scope}}/domain test   # one package's tests
```

## What is in it

Seven packages under `packages/`, each named `{{scope}}/<folder>` and imported
by that name:

```ts
import type { PricePort } from "{{scope}}/domain";
```

They hold one small feature, a live price list, built the way every feature is
meant to be built. It is an example to copy, not part of the product.
[AGENTS.md](AGENTS.md) says where each kind of code goes and lists the file
that shows each pattern.

Packages export their TypeScript source. Nothing is compiled except the client,
which Vite bundles; the server and the tooling are run by Node directly. This
needs Node 24 or later.

## The checks

The architecture gates, the lint rules and the agent hooks live in
`tools/arch`, and [its README](tools/arch/README.md) describes them. They are
files in this project, so they apply to everyone who works on it and to CI.

## Add-ons

{{addons}}

## By hand

- **A newer pnpm.** `packageManager` in `package.json` names pnpm by its
  version and by the hash of that release, which Corepack checks the download
  against. To move to another version run
  `node tools/arch/ci/pin-package-manager.mts pnpm@<version> --write`, then
  `pnpm install`. Do not type the hash.
- **What an add-on leaves to a person** is written at the top of the file it
  gave the project to keep. Read that file once: a security policy has times
  to make your own, and an update bot may need an app installed on the
  repository before it does anything. Settings on GitHub that no file can
  make are listed in that add-on's README, in the repository below.

`tools/installed.json` records what is installed now. The kit and the add-ons
come from <https://github.com/bettersoftware-io/skills>, which also holds the
script that adds one or brings one up to date.
