import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Once this ran the compiler: babel({ presets: [reactCompilerPreset()] }).
// The preset is still imported, and nothing calls it.
void reactCompilerPreset;

export default defineConfig({
  plugins: [react()],
});
