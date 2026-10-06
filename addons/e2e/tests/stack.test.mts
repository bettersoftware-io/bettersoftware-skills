import { describe, expect, it } from "vitest";

import { E2eError, SERVER_HOST, SERVER_URL } from "../files/tools/e2e/lib/config.mts";
import { readHost, resolveEnv } from "../files/tools/e2e/lib/stack.mts";

const SERVER = { url: "ws://localhost:4010/ws", host: "localhost:4010" };

describe("the variables a mode's build is given", () => {
  it("are passed as written when they name no server", () => {
    expect(resolveEnv("sim", { VITE_SERVER_URL: "", VITE_THEME: "dark" }, undefined)).toEqual({ VITE_SERVER_URL: "", VITE_THEME: "dark" });
  });

  it("carry the address the mode's server printed, wherever it is asked for", () => {
    expect(resolveEnv("fullstack", { VITE_SERVER_URL: SERVER_URL, VITE_HEALTH: `${SERVER_URL}/health` }, SERVER)).toEqual({
      VITE_SERVER_URL: "ws://localhost:4010/ws",
      VITE_HEALTH: "ws://localhost:4010/ws/health",
    });
  });

  it("carry the server's host and port, so one server can be named once for each protocol it answers", () => {
    expect(
      resolveEnv("fullstack", { VITE_SERVER_URL: `ws://${SERVER_HOST}/ws`, VITE_API_URL: `http://${SERVER_HOST}`, VITE_BOTH: `${SERVER_URL} ${SERVER_HOST}` }, SERVER),
    ).toEqual({
      VITE_SERVER_URL: "ws://localhost:4010/ws",
      VITE_API_URL: "http://localhost:4010",
      VITE_BOTH: "ws://localhost:4010/ws localhost:4010",
    });
  });

  it.each([SERVER_URL, `http://${SERVER_HOST}`])("refuse to ask for the address of a server the mode does not have: %s", (value) => {
    const resolve = (): unknown => resolveEnv("sim", { VITE_SERVER_URL: value }, undefined);

    expect(resolve).toThrow(E2eError);
    expect(resolve).toThrow('the mode "sim" gives VITE_SERVER_URL the server\'s address, and has no server to take it from');
  });
});

describe("the host and port of a mode's server", () => {
  it.each([
    ["ws://localhost:4010/ws", "localhost:4010"],
    ["http://127.0.0.1:4010", "127.0.0.1:4010"],
    ["http://127.0.0.1:4010/api/v1?x=1", "127.0.0.1:4010"],
    ["ws://[::1]:4010/ws", "[::1]:4010"],
    // What the demo's config captures: the host and the port, with no protocol.
    ["localhost:4010", "localhost:4010"],
    ["127.0.0.1:4010", "127.0.0.1:4010"],
    ["[::1]:4010", "[::1]:4010"],
  ])("is read out of %s", (printed, host) => {
    expect(readHost("fullstack", printed)).toBe(host);
  });

  it.each(["4010", "port 4010", "localhost:4010/ws", "", "ws://"])("is refused when the pattern captured \"%s\", which names no host and port", (printed) => {
    const read = (): unknown => readHost("fullstack", printed);

    expect(read).toThrow(E2eError);
    expect(read).toThrow(
      `the server of mode "fullstack" was ready at "${printed}", which is neither an address (ws://localhost:4000/ws) nor a host and a port (localhost:4000). Change the group of its "ready" pattern to capture one of those`,
    );
  });
});
