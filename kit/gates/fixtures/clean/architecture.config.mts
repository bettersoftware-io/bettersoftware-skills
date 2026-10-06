export default {
  packages: {
    "packages/domain": { role: "domain", npm: ["rxjs"] },
    "packages/contract-types": { role: "leaf", typesOnly: true },
    "packages/client-core": { role: "core", noNodeBuiltins: true },
    "packages/react-bindings": { role: "bindings" },
    "packages/client-react": { role: "client" },
    "packages/integration": { role: "integration" },
    "packages/e2e": { role: "e2e" },
  },
  adapters: ["packages/domain/src/simulators", "packages/client-core/src/adapters"],
  tasksThatReadNothingUpstream: {
    format: "the formatter reads one file at a time and resolves no import",
  },
  packagesWithoutTests: {
    "packages/contract-types": "it holds only types, so there is nothing to run",
  },
  vendorOnlyIn: {
    react: ["packages/react-bindings", "packages/client-react"],
  },
};
