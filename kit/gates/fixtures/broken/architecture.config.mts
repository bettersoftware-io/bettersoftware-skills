export default {
  packages: {
    "packages/domain": { role: "domain", npm: ["rxjs"] },
    "packages/contract-types": { role: "leaf", typesOnly: true },
    "packages/client-core": { role: "core", noNodeBuiltins: true },
    "packages/react-bindings": { role: "bindings" },
    "packages/client-react": { role: "client" },
    "packages/checks": { role: "integration" },
    "packages/browser-tests": { role: "e2e" },
  },
  adapters: ["packages/domain/src/simulators", "packages/client-core/src/adapters"],
  javascriptAllowed: {
    "stylelint.config.mjs": "stylelint's config loader cannot read .mts",
  },
  packagesWithoutTests: {
    "packages/rogue": "it holds one constant and no behaviour",
  },
  vendorOnlyIn: {
    ws: ["packages/checks"],
  },
};
