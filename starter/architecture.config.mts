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
const config: ArchitectureConfig = {
  packages: {
    "packages/domain": { role: "domain", npm: ["rxjs"] },
    "packages/shared": { role: "shared" },
    "packages/client-core": { role: "core" },
    "packages/react-bindings": { role: "bindings" },
    "packages/client-react": { role: "client", entry: ["main.tsx", "index.css", "*.d.ts"] },
    "packages/server": { role: "server" },
  },

  // Folders whose modules implement ports. Each must run the contract test of
  // every port it implements.
  adapters: ["packages/domain/src/simulators", "packages/client-core/src/adapters"],
};

export default config;
