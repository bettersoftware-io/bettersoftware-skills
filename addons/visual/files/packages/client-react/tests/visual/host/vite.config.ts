import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { HOST, PORT } from "./address.ts";

// Serves the visual host: a page that renders one scenario. It is a second,
// separate Vite root, so the app's own config and entry are not touched.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // A cache of its own, so the host and `pnpm dev` never invalidate each other's.
  cacheDir: fileURLToPath(new URL("../../../node_modules/.vite-visual", import.meta.url)),
  plugins: [react()],
  server: {
    host: HOST,
    port: PORT,
    // Fail if the port is taken. Moving to the next free one would leave
    // Playwright waiting on an address nothing serves.
    strictPort: true,
    // Nothing may reload the page between the ready signal and the picture.
    hmr: false,
  },
});
