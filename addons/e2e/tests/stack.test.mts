import { describe, expect, it } from "vitest";

import { E2eError, SERVER_URL } from "../files/tools/e2e/lib/config.mts";
import { resolveEnv } from "../files/tools/e2e/lib/stack.mts";

describe("the variables a mode's build is given", () => {
  it("are passed as written when they name no server", () => {
    expect(resolveEnv("sim", { VITE_SERVER_URL: "", VITE_THEME: "dark" }, undefined)).toEqual({ VITE_SERVER_URL: "", VITE_THEME: "dark" });
  });

  it("carry the address the mode's server printed, wherever it is asked for", () => {
    expect(resolveEnv("fullstack", { VITE_SERVER_URL: SERVER_URL, VITE_HEALTH: `${SERVER_URL}/health` }, "ws://localhost:4010/ws")).toEqual({
      VITE_SERVER_URL: "ws://localhost:4010/ws",
      VITE_HEALTH: "ws://localhost:4010/ws/health",
    });
  });

  it("refuse to ask for the address of a server the mode does not have", () => {
    const resolve = (): unknown => resolveEnv("sim", { VITE_SERVER_URL: SERVER_URL }, undefined);

    expect(resolve).toThrow(E2eError);
    expect(resolve).toThrow('the mode "sim" gives VITE_SERVER_URL the server\'s address, and has no server to take it from');
  });
});
