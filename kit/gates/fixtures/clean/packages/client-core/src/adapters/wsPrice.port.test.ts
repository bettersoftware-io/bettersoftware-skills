import { createServer } from "node:net";
import { describe } from "vitest";

// A test may use a Node built-in, in a package whose production code may not.
describe("the adapter against a real socket", () => {
  void createServer;
});
