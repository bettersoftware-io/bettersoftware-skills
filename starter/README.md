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
which Vite bundles; the server and the tooling are run by Node directly. This
needs Node 24 or later.

The checks live in `tools/arch` and are described in its README.
