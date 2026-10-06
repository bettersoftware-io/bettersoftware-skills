import type { Page } from "@playwright/test";

import type { ServerMessage } from "@app/shared/protocol.ts";

/** A price as the server sent it, written the way the price list shows one. */
interface SentPrice {
  symbol: string;
  mid: string;
}

/** What the page has been sent, read off the wire and not off the screen. */
export interface ServerFeedPage {
  /** Every address the page opened a socket to. */
  connections: () => string[];
  /** The latest price the server sent for each symbol, in symbol order. */
  latestSent: () => SentPrice[];
}

/**
 * Listens to the sockets the page opens, from before the page loads. Frames
 * count only when they come from `serverUrl`, so what this reports was sent
 * by that server and by nothing else.
 */
export function watchServerFeed(page: Page, serverUrl: string): ServerFeedPage {
  const connections: string[] = [];
  const latest = new Map<string, string>();

  page.on("websocket", (socket) => {
    connections.push(socket.url());

    if (serverUrl === "" || !sameAddress(socket.url(), serverUrl)) {
      return;
    }

    socket.on("framereceived", ({ payload }) => {
      const message = readMessage(payload);

      if (message?.type === "price") {
        // Four decimals: how the price list writes a mid.
        latest.set(message.payload.symbol, message.payload.mid.toFixed(4));
      }
    });
  });

  return {
    connections: (): string[] => {
      return [...connections];
    },
    latestSent: (): SentPrice[] => {
      return [...latest]
        .map(([symbol, mid]) => {
          return { symbol, mid };
        })
        .sort((a, b) => {
          return a.symbol.localeCompare(b.symbol);
        });
    },
  };
}

/** The frame as a message of the protocol, or undefined when it is not JSON. */
function readMessage(payload: string | Buffer): ServerMessage | undefined {
  try {
    return JSON.parse(payload.toString()) as ServerMessage;
  } catch {
    return undefined;
  }
}

function sameAddress(a: string, b: string): boolean {
  return new URL(a).href === new URL(b).href;
}
