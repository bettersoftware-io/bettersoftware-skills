export default {
  packages: {
    "packages/domain": { role: "domain", npm: ["rxjs"] },
    "packages/client-core": { role: "core" },
    "packages/react-bindings": { role: "bindings" },
    "packages/client-react": { role: "client" },
    "packages/integration": { role: "integration" },
  },
  adapters: ["packages/domain/src/simulators", "packages/client-core/src/adapters"],
};
