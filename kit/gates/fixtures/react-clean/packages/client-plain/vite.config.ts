import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Once this ran the compiler: babel({ presets: [reactCompilerPreset()] }).
export default defineConfig({
  plugins: [react()],
});
