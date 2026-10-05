import { EventEmitter } from "node:events";
import type { Server } from "node:net";
import { describe, expect, it } from "vitest";

import { canListen, hasPortTests, portTestsAreSkipped } from "../files/tools/coverage/lib/listening.mts";
import { createWorkspace } from "./support.mts";

describe("whether the port tests are skipped here", () => {
  it("is no where a port can be opened", async () => {
    expect(await portTestsAreSkipped({}, () => Promise.resolve(true))).toBe(false);
  });

  it("is yes where none can", async () => {
    expect(await portTestsAreSkipped({}, () => Promise.resolve(false))).toBe(true);
  });

  it("is never yes in CI, and CI is not even asked", async () => {
    let asked = false;
    const skipped = await portTestsAreSkipped({ CI: "true" }, () => {
      asked = true;

      return Promise.resolve(false);
    });

    expect(skipped).toBe(false);
    expect(asked).toBe(false);
  });
});

describe("asking whether a process may listen on a port", () => {
  it("says yes where one can be opened", async () => {
    expect(await canListen()).toBe(true);
  });

  it("says no where the host refuses", async () => {
    expect(await canListen(() => createRefusingServer("EPERM"))).toBe(false);
    expect(await canListen(() => createRefusingServer("EACCES"))).toBe(false);
  });

  it("does not take another failure for a refusal", async () => {
    await expect(canListen(() => createRefusingServer("EMFILE"))).rejects.toThrow("EMFILE");
  });
});

describe("finding a package's port tests", () => {
  it("finds one in any folder of the package", () => {
    const root = createWorkspace(["packages/server"], { "packages/server/src/http/startServer.port.test.ts": "" });

    expect(hasPortTests(root, "packages/server")).toBe(true);
  });

  it("finds none in a package whose tests need no port", () => {
    const root = createWorkspace(["packages/domain"], { "packages/domain/src/price.test.ts": "" });

    expect(hasPortTests(root, "packages/domain")).toBe(false);
  });

  it("does not look in installed or generated folders", () => {
    const root = createWorkspace(["packages/domain"], {
      "packages/domain/node_modules/dep/a.port.test.ts": "",
      "packages/domain/dist/a.port.test.ts": "",
      "packages/domain/coverage/a.port.test.ts": "",
    });

    expect(hasPortTests(root, "packages/domain")).toBe(false);
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
