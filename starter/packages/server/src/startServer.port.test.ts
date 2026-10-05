import { connect } from "node:net";

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

  it("gives every connected client the same prices, from one feed", async () => {
    const prices$ = new Subject<Price>();
    let feeds = 0;
    const server = await startServer({
      port: 0,
      prices: {
        prices: () => {
          feeds += 1;

          return prices$;
        },
      },
    });

    onTestFinished(() => server.close());

    const first = await connectClient(server.port);
    const second = await connectClient(server.port);
    const received = Promise.all([first.nextMessage(), second.nextMessage()]);

    prices$.next({ symbol: "EURUSD", mid: 1.1 });

    expect(await received).toEqual([
      encodePrice({ symbol: "EURUSD", mid: 1.1 }),
      encodePrice({ symbol: "EURUSD", mid: 1.1 }),
    ]);
    expect(feeds).toBe(1);
  });

  it("drops a client that breaks the protocol, and keeps serving the others", async () => {
    const prices$ = new Subject<Price>();
    const server = await startTestServer(prices$);
    const healthy = await connectClient(server.port);

    await breakTheProtocol(server.port);

    const message = healthy.nextMessage();

    prices$.next({ symbol: "EURUSD", mid: 1.1 });

    expect(await message).toEqual(encodePrice({ symbol: "EURUSD", mid: 1.1 }));
  });

  it("stops listening to the price source when the last client leaves", async () => {
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

/**
 * Connects by hand and sends a frame no WebSocket client may send: one that is
 * not masked. Resolves when the server has dropped the connection.
 */
function breakTheProtocol(port: number): Promise<void> {
  const UNMASKED_TEXT_FRAME = Buffer.from([0x81, 0x01, 0x61]);
  const socket = connect(port, "localhost");

  socket.write(
    [
      `GET ${WS_PATH} HTTP/1.1`,
      `Host: localhost:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );
  socket.once("data", () => {
    socket.write(UNMASKED_TEXT_FRAME);
  });

  return new Promise((dropped) => {
    socket.once("close", () => {
      dropped();
    });
  });
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
