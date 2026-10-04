import type { PricePort } from "@app/domain";
import { encodePrice, WS_PATH } from "@app/shared";
import { WebSocketServer } from "ws";

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
 * Streams prices to every client that connects. Each connection gets its own
 * subscription to the price port, released when the connection ends.
 *
 * The server takes its price source as a port, like the client does, so a test
 * drives it by hand and production runs it on the simulator.
 */
export function startServer({ port, prices }: ServerOptions): Promise<RunningServer> {
  const server = new WebSocketServer({ port, path: WS_PATH });

  server.on("connection", (socket) => {
    const subscription = prices.prices().subscribe((price) => {
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
      const address = server.address();

      resolve({
        port: typeof address === "object" && address !== null ? address.port : port,
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
