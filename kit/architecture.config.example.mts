// Copy to the repo root as `architecture.config.mts` and edit.
//
// Every workspace package must appear here with the role it plays. A package
// that is not listed fails the structure gate: new packages are forbidden by
// default, so a rule can never be silently missing for one.
//
// Role             May import
// domain           nothing
// leaf             nothing
// shared           domain, leaf
// core             domain, shared, leaf
// bindings         core, domain, leaf
// client           bindings, core, domain, leaf
// server           domain, shared, leaf

import type { ArchitectureConfig } from "./tools/arch/gates/lib/config.mts";

const config: ArchitectureConfig = {
  packages: {
    // Entities, use cases, port interfaces, simulators. `npm` is the closed
    // list of runtime dependencies; anything else in package.json fails.
    "packages/domain": { role: "domain", npm: ["rxjs"] },

    // Wire protocol: DTOs and message names shared by the core's adapters and
    // the server.
    "packages/shared": { role: "shared" },

    // Presenters, state machines, adapters. Framework-free.
    "packages/client-core": { role: "core" },

    // The one place the stream library meets the UI framework.
    "packages/react-bindings": { role: "bindings" },

    // A client holds two folders: `src/app` (composition root) and `src/ui`
    // (dumb UI). Override with `app`, `ui`, `uiBridge` and `entry` if needed.
    "packages/client-react": { role: "client" },

    "packages/server": { role: "server" },
  },

  // Folders whose modules implement ports. Each one that implements a port
  // must run that port's contract test.
  adapters: ["packages/domain/src/simulators", "packages/client-core/src/adapters"],

  // A port that deliberately has no contract test, and why.
  contractExempt: {},

  // "typescript" (the default) fails on any JavaScript source file. List here
  // the files a tool can only load as JavaScript, each with the reason.
  language: "typescript",
  javascriptAllowed: {},
};

export default config;
