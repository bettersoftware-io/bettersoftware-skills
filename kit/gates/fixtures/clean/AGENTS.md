# Working in this project

The port is `packages/domain/src/ports/pricePort.ts`, declared at
`packages/domain/src/ports/pricePort.ts:1`, and its contract is in
`packages/domain/src/ports/__contracts__/`. Adapters go in
`client-core/src/adapters`, which is a path from the packages folder and is
not judged. Neither is `packages/<name>/src`, `packages/*/dist/index.js`, a
command like `pnpm test packages/domain`, a built file like
`packages/client-core/dist/index.js`, `/usr/local/bin` or
`../sibling/README.md`.

See [the declaration](architecture.config.mts#packages),
[a section](#working-in-this-project), [the web](https://example.com/packages/gone),
[an issue](/issues/1), [a sibling](../sibling/README.md) and
[a report](packages/domain/coverage/index.html).

```bash
cat packages/domain/src/ports/gone.ts   # an example: `packages/domain/gone.ts`
```

<!-- BEGIN:some-tool -->
A tool wrote this block. `packages/domain/README.md` is a path in its own
repository, not this one.
<!-- END:some-tool -->

After the block, paths are judged again: `packages/domain/src/index.ts`.
