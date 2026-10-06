import type { ArchitectureConfig } from "./tools/arch/gates/lib/config.mts";

// Every workspace package appears here with the role it plays. A package that
// is not listed fails the structure gate, so a new one cannot slip in without
// its rules.
//
// Role       May import
// domain     nothing
// leaf       nothing
// shared     domain, leaf
// core       domain, shared, leaf
// bindings   core, domain, leaf
// client     bindings, core, domain, leaf
// server     domain, shared, leaf
// integration  every role above; nothing may import it, and it holds only tests
// e2e        no source of the application: only a client's test ids, and types
const config: ArchitectureConfig = {
  packages: {
    // `noNodeBuiltins` is on for every package that ends up in the browser.
    // The domain has it by default.
    "packages/domain": { role: "domain", npm: ["rxjs"] },
    "packages/shared": { role: "shared", noNodeBuiltins: true },
    "packages/client-core": { role: "core", noNodeBuiltins: true },
    "packages/react-bindings": { role: "bindings", noNodeBuiltins: true },
    // `reactCompiler` says the client's build runs the React Compiler, which
    // is why its source may not use useMemo, useCallback or memo.
    // `compilerTracked` lists what relies on that: `pnpm check:compiler`
    // fails when the compiler stops memoizing one of them.
    "packages/client-react": {
      role: "client",
      entry: ["main.tsx", "index.css", "*.d.ts"],
      noNodeBuiltins: true,
      reactCompiler: true,
      compilerTracked: [{ file: "src/ui/PriceList.tsx", fn: "PriceRowView" }],
    },
    "packages/server": { role: "server" },
    "packages/integration": { role: "integration" },
  },

  // Folders whose modules implement ports. Each must run the contract test of
  // every port it implements.
  adapters: [
    "packages/domain/src/simulators",
    "packages/client-core/src/adapters",
  ],

  // A library named here may be imported only from the packages listed, so it
  // can be replaced by changing those alone.
  vendorOnlyIn: {
    react: ["packages/react-bindings", "packages/client-react"],
    "react-dom": ["packages/react-bindings", "packages/client-react"],
    ws: ["packages/server"],
  },
};

export default config;
