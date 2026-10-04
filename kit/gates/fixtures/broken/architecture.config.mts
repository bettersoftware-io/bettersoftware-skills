export default {
  packages: {
    "packages/domain": { role: "domain", npm: ["rxjs"] },
    "packages/client-core": { role: "core" },
    "packages/react-bindings": { role: "bindings" },
    "packages/client-react": { role: "client" },
  },
  adapters: ["packages/domain/src/simulators", "packages/client-core/src/adapters"],
  javascriptAllowed: {
    "stylelint.config.mjs": "stylelint's config loader cannot read .mts",
  },
};
