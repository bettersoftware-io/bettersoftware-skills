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
// integration      every role above. Nothing may import it; it holds only tests
// e2e              no source of the application: only a client's test ids, and
//                  types. Nothing may import it; it holds only specs, page
//                  objects and a testing folder, and is run by a root script

import type { ArchitectureConfig } from "./tools/arch/gates/lib/config.mts";

const config: ArchitectureConfig = {
  packages: {
    // Entities, use cases, port interfaces, simulators. `npm` is the closed
    // list of runtime dependencies; anything else in package.json fails.
    "packages/domain": { role: "domain", npm: ["rxjs"] },

    // Wire protocol: DTOs and message names shared by the core's adapters and
    // the server. `noNodeBuiltins` holds any package to the domain's rule: no
    // Node built-in in production code, so it loads in a browser.
    "packages/shared": { role: "shared", noNodeBuiltins: true },

    // Presenters, state machines, adapters. Framework-free. The three options
    // are the defaults: the files that may import an adapter (to re-export
    // it), the function that builds the application, and the one test helper
    // that may call it.
    "packages/client-core": {
      role: "core",
      noNodeBuiltins: true,
      mayImportAdapters: ["src/index.ts"],
      compose: "createApp",
      appHarness: "src/testing/appHarness.ts",
    },

    // The one place the stream library meets the UI framework.
    "packages/react-bindings": { role: "bindings" },

    // A client holds two folders: `src/app` (composition root) and `src/ui`
    // (dumb UI). Override with `app`, `ui`, `uiBridge` and `entry` if needed.
    // `testIds` is the file in `ui` that holds every test id (the default).
    //
    // `reactCompiler: true` says the client's build runs the React Compiler.
    // The lint then bans useMemo, useCallback and memo in its source, and
    // `check-react-policies.mts` fails if the build does not run it.
    // `compilerTracked` lists the functions that rely on it, for
    // `check-compiler.mts`. Leave both out for a client without the compiler.
    "packages/client-react": {
      role: "client",
      testIds: "testids.ts",
      reactCompiler: true,
      compilerTracked: [{ file: "src/ui/PriceList.tsx", fn: "PriceRowView" }],
    },

    "packages/server": { role: "server" },

    // Tests that run two sides against each other, such as a client adapter
    // against the real server. The one package that may import every layer.
    "packages/integration": { role: "integration" },

    // A package of shared types adds `typesOnly: true`: it may then export no
    // runtime value.
    // "packages/core-api": { role: "leaf", typesOnly: true },

    // End-to-end tests that drive the built application in a browser. It
    // imports none of the packages above, only the client's test ids, and has
    // no `test` script: a script of the root runs it.
    // "packages/e2e": { role: "e2e" },
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

  // Every package needs a `typecheck` and a `test` script. A package with no
  // tests is listed here with the reason.
  packagesWithoutTests: {},

  // A library that may be imported only from the packages listed.
  vendorOnlyIn: {
    react: ["packages/react-bindings", "packages/client-react"],
    "react-dom": ["packages/react-bindings", "packages/client-react"],
    ws: ["packages/server"],
  },

  // A package that imports React and is neither a client nor the bindings
  // gets none of React's lint rules. List it here with the reason.
  reactWithoutPolicies: {},
};

export default config;
