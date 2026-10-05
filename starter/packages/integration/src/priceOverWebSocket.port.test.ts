import { createWsConnection, createWsPricePort } from "@app/client-core";
import type { Price, PricePort } from "@app/domain";
import { startServer } from "@app/server/startServer.ts";
import { WS_PATH } from "@app/shared";
import { defer, finalize, firstValueFrom, Subject, timeout } from "rxjs";
import { describe, expect, it, onTestFinished } from "vitest";

// Each side has its own tests against the shared protocol: the adapter against
// a scripted connection, the server against a raw socket. Neither shows that
// the two agree. These run the client's real adapter against the real server,
// over a real WebSocket, which is the one thing only this package may do.
describe("the client's price adapter against the real server", () => {
  it("receives a price the server's source produces, unchanged", async () => {
    const { port, produce, feedOpened } = await startBothEnds();
    const received = firstValueFrom(port.prices().pipe(timeout(GIVE_UP_AFTER_MS)));

    await feedOpened;
    produce({ symbol: "EURUSD", mid: 1.1 });

    expect(await received).toEqual({ symbol: "EURUSD", mid: 1.1 });
  });

  it("closes the server's feed when the last subscriber leaves", async () => {
    const { port, feedOpened, feedClosed } = await startBothEnds();
    const subscription = port.prices().subscribe();

    await feedOpened;
    subscription.unsubscribe();

    await expect(feedClosed).resolves.toBe("closed");
  });
});

// A deadline for the one wait that has no event to wait on: a price that never
// arrives. It ends the subscription, so a failing run reports and stops.
const GIVE_UP_AFTER_MS = 2000;

interface BothEnds {
  /** The client's port, on a real WebSocket to the real server. */
  port: PricePort;
  /** Makes the server's price source produce this price. */
  produce: (price: Price) => void;
  /** Settles when the server opens its feed, which it does when the first client has connected. */
  feedOpened: Promise<void>;
  /** Settles when the server closes its feed, which it does when the last client has left. */
  feedClosed: Promise<"closed">;
}

/** A real server on a free port, fed by hand, and the client's adapter pointed at it. */
async function startBothEnds(): Promise<BothEnds> {
  const source$ = new Subject<Price>();
  const opened = createSignal<void>();
  const closed = createSignal<"closed">();
  const server = await startServer({
    port: 0,
    prices: {
      prices: () =>
        defer(() => {
          opened.settle();

          return source$;
        }).pipe(
          finalize(() => {
            closed.settle("closed");
          }),
        ),
    },
  });

  onTestFinished(() => server.close());

  return {
    port: createWsPricePort(createWsConnection(`ws://localhost:${server.port}${WS_PATH}`)),
    produce: (price): void => {
      source$.next(price);
    },
    feedOpened: opened.promise,
    feedClosed: closed.promise,
  };
}

interface Signal<T> {
  promise: Promise<T>;
  settle: (value: T) => void;
}

function createSignal<T>(): Signal<T> {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });

  return { promise, settle };
}
