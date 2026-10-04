import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["kit/**/*.test.mts", "scripts/**/*.test.mts", "addons/*/tests/**/*.test.mts"],
  },
});
