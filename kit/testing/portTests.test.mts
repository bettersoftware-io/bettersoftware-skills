import { EventEmitter } from "node:events";
import type { Server } from "node:net";
import { matchesGlob } from "node:path";
import { describe, expect, it } from "vitest";

import { canListen, PORT_TESTS, portTestsToSkip } from "./portTests.mts";

describe("asking whether a process may listen on a port", () => {
  it("says yes where one can be opened", async () => {
    expect(await canListen()).toBe(true);
  });

  it("says no where the host refuses, as Codex's sandbox does", async () => {
    expect(await canListen(() => createRefusingServer("EPERM"))).toBe(false);
    expect(await canListen(() => createRefusingServer("EACCES"))).toBe(false);
  });

  it("does not take another failure for a refusal", async () => {
    await expect(canListen(() => createRefusingServer("EMFILE"))).rejects.toThrow("EMFILE");
  });
});

describe("choosing the tests to leave out", () => {
  it("leaves none out where a port can be opened", async () => {
    const said: string[] = [];

    expect(await portTestsToSkip({ environment: {}, probe: () => Promise.resolve(true), say: (line) => said.push(line) })).toEqual([]);
    expect(said).toEqual([]);
  });

  it("leaves out the tests that need a port where none can be opened, and says so", async () => {
    const said: string[] = [];
    const skipped = await portTestsToSkip({ environment: {}, probe: () => Promise.resolve(false), say: (line) => said.push(line) });

    expect(skipped).toEqual([PORT_TESTS]);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^SKIP /);
    expect(said[0]).toContain("not verified here");
  });

  it("never leaves any out in CI, where a test that cannot run must fail", async () => {
    let asked = false;
    const skipped = await portTestsToSkip({
      environment: { CI: "true" },
      probe: () => {
        asked = true;

        return Promise.resolve(false);
      },
      say: () => {},
    });

    expect(skipped).toEqual([]);
    expect(asked).toBe(false);
  });

  it("names its files by a pattern that matches a port test and no other test", () => {
    expect(matchesGlob("src/startServer.port.test.ts", PORT_TESTS)).toBe(true);
    expect(matchesGlob("src/ui/Chart.port.test.tsx", PORT_TESTS)).toBe(true);
    expect(matchesGlob("src/startServer.test.ts", PORT_TESTS)).toBe(false);
  });
});

/** A server whose `listen` fails the way the operating system reports a refusal. */
function createRefusingServer(code: string): Server {
  const server = new EventEmitter() as Server;

  server.listen = ((): Server => {
    queueMicrotask(() => {
      server.emit("error", Object.assign(new Error(`listen ${code}`), { code }));
    });

    return server;
  }) as Server["listen"];

  return server;
}
