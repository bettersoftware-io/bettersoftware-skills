#!/usr/bin/env node
// Lints the project's GitHub workflows before they are pushed.
//
//   node tools/ci-security/lint-workflows.mts              both linters
//   node tools/ci-security/lint-workflows.mts actionlint   is each workflow valid?
//   node tools/ci-security/lint-workflows.mts zizmor       is each workflow safe?
//
// Each linter is a pinned release (lib/pins.mts). It is downloaded once, its
// sha256 is checked before anything is taken out of it, and the archive is
// kept in node_modules/.cache/ci-security, which git ignores. The first run
// therefore needs the network. That is why this is not in `pnpm gate:fast` or
// `pnpm gate:full`: a gate needs nothing beyond `pnpm install`.
//
// Exit 0: every linter ran and found nothing. Exit 1: a linter found a
// problem, and its own output names it. Exit 2: a linter could not run (no
// network, no build for this machine, a wrong checksum), or there was no
// workflow to lint. Exit 2 is not a pass; say that the lint did not run.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installVerified } from "./lib/install.mts";
import { lintWorkflows } from "./lib/lint.mts";
import { platformKey } from "./lib/pins.mts";
import { createDownload, extractWithTar, hasCommand, isMainModule, runInherited } from "./lib/system.mts";

if (isMainModule(import.meta.url)) {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const download = createDownload();

  // Set, not process.exit(): the lines printed above still reach a pipe that is slow to read.
  process.exitCode = await lintWorkflows({
    root,
    names: process.argv.slice(2),
    install: (pin) =>
      installVerified({
        pin,
        platform: platformKey(process.platform, process.arch),
        cache: join(root, "node_modules", ".cache", "ci-security"),
        download,
        extract: extractWithTar,
      }),
    run: runInherited,
    env: process.env,
    hasCommand: (name) => hasCommand(name, process.env.PATH),
    report: (line) => console.log(line),
  });
}
