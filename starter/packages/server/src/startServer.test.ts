import type { Price } from "@app/domain";
import { encodePrice, WS_PATH } from "@app/shared";
import { Subject } from "rxjs";
import { describe, expect, it, onTestFinished } from "vitest";

import { type RunningServer, startServer } from "./startServer.ts";

describe("the price server", () => {
  it("sends each price to a connected client as a wire message", async () => {
    const prices$ = new Subject<Price>();
    const server = await startTestServer(prices$);
    const client = await connectClient(server.port);
    const message = client.nextMessage();

    prices$.next({ symbol: "EURUSD", mid: 1.1 });

    expect(await message).toEqual(encodePrice({ symbol: "EURUSD", mid: 1.1 }));
  });

  it("stops listening to the price source when the client leaves", async () => {
    const prices$ = new Subject<Price>();
    const server = await startTestServer(prices$);
    const client = await connectClient(server.port);

    expect(prices$.observed).toBe(true);

    await client.close();
    await expect.poll(() => prices$.observed).toBe(false);
  });
});

/** A server on a free port, fed by hand and closed when the test ends. */
async function startTestServer(prices$: Subject<Price>): Promise<RunningServer> {
  const server = await startServer({ port: 0, prices: { prices: () => prices$ } });

  onTestFinished(() => server.close());

  return server;
}

interface ConnectedClient {
  nextMessage: () => Promise<unknown>;
  close: () => Promise<void>;
}

/** Resolves once the connection is open, which is after the server has subscribed. */
function connectClient(port: number): Promise<ConnectedClient> {
  const socket = new WebSocket(`ws://localhost:${port}${WS_PATH}`);

  return new Promise((resolve, reject) => {
    socket.addEventListener("error", () => {
      reject(new Error("the client could not connect"));
    });
    socket.addEventListener("open", () => {
      resolve({
        nextMessage: () =>
          new Promise((received) => {
            socket.addEventListener(
              "message",
              (event) => {
                received(JSON.parse(String(event.data)));
              },
              { once: true },
            );
          }),
        close: () =>
          new Promise<void>((closed) => {
            socket.addEventListener("close", () => {
              closed();
            });
            socket.close();
          }),
      });
    });
  });
}
