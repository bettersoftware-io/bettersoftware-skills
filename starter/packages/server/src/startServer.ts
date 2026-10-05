import type { AddressInfo } from "node:net";

import { share } from "rxjs";
import { WebSocketServer } from "ws";

import type { PricePort } from "@app/domain";
import { encodePrice, WS_PATH } from "@app/shared";

export interface ServerOptions {
  /** 0 picks a free port. */
  port: number;
  prices: PricePort;
}

export interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

/**
 * Streams prices to every client that connects. All connections share one
 * feed, so every client sees the same prices; the feed opens with the first
 * client and closes when the last one leaves.
 *
 * The server takes its price source as a port, like the client does, so a test
 * drives it by hand and production runs it on the simulator.
 */
export function startServer({ port, prices }: ServerOptions): Promise<RunningServer> {
  const server = new WebSocketServer({ port, path: WS_PATH });
  const prices$ = prices.prices().pipe(share());

  server.on("connection", (socket) => {
    const subscription = prices$.subscribe((price) => {
      socket.send(JSON.stringify(encodePrice(price)));
    });

    socket.on("close", () => {
      subscription.unsubscribe();
    });

    // Without a listener, one client's protocol error would end the process.
    socket.on("error", () => {
      socket.terminate();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      resolve({
        // A server listening on a TCP port always reports an address object.
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((closed) => {
            for (const client of server.clients) {
              client.terminate();
            }

            server.close(() => {
              closed();
            });
          }),
      });
    });
  });
}
