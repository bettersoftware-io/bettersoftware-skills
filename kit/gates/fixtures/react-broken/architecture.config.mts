// Every way a package may import React and not be under the rules for it.
export default {
  packages: {
    "packages/domain": { role: "domain" },
    "packages/react-bindings": { role: "bindings" },
    // Says it runs the compiler; its build does not.
    "packages/client-react": { role: "client", reactCompiler: true },
    // Says it runs the compiler; it has no build config at all.
    "packages/client-bare": { role: "client", reactCompiler: true },
    // Runs the compiler and does not say so.
    "packages/client-quiet": { role: "client" },
    // Compiler declared and wired; the project's ESLint config undoes the rules.
    "packages/client-loose": {
      role: "client",
      reactCompiler: true,
      compilerTracked: [
        { file: "src/ui/App.tsx", fn: "App" },
        { file: "src/ui/Inline.tsx", fn: "Inline", values: ["label", "gone"] },
        { file: "src/ui/Bails.tsx", fn: "Bails", values: ["doubled"] },
        { file: "src/ui/Renamed.tsx", fn: "OldName" },
        { file: "src/ui/Moved.tsx", fn: "Moved" },
        { file: "src/ui/App.tsx", fn: "App", minMemoValues: 4 },
      ],
    },
    // The project's ESLint config ignores the whole package.
    "packages/client-unlinted": { role: "client" },
    // React in a package whose role gets no React rule.
    "packages/ui-kit": { role: "leaf" },
    "packages/icons": { role: "leaf" },
  },
  reactWithoutPolicies: {
    "packages/icons": "generated from the design files and never edited by hand",
    "packages/domain": "it used to render a chart",
  },
};
