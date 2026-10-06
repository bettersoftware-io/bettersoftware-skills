import { configDefaults, defineConfig } from "vitest/config";

import { portTestsToSkip } from "../../tools/arch/testing/portTests.mts";

// The tests named *.port.test.ts open a real port. Where a process may not
// listen (Codex's sandbox), they are left out with a line that says so. In CI
// they always run.
export default defineConfig(async () => {
  const skipped = await portTestsToSkip();

  return {
    test: {
      exclude: [...configDefaults.exclude, ...skipped],
      passWithNoTests: skipped.length > 0,
    },
  };
});
