import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The React Compiler memoizes components and hooks at build time, which is
// why this package writes no `useMemo`, `useCallback` or `memo` (the lint bans
// them). The React plugin has no Babel step of its own, so the compiler runs
// through the Babel plugin, with the preset the React plugin exports for it.
// `pnpm check:compiler` proves it still compiles what relies on it.
//
// Tests are not compiled: they run on vitest.config.ts.
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
});
