import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmounts whatever a test rendered, so one test's screen never leaks into the
// next. The testing library does this by itself only when the test runner's
// globals are switched on, which they are not here.
afterEach(() => {
  cleanup();
});
