import { afterEach, beforeEach, vi } from "vitest";

import type { Price } from "../entities/price.ts";
import { describePricePortContract } from "../ports/__contracts__/PricePortContract.ts";
import { createPriceSimulator } from "./priceSimulator.ts";

const INTERVAL_MS = 500;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describePricePortContract("price simulator", () => {
  const queued: Price[] = [];

  return {
    port: createPriceSimulator({
      intervalMs: INTERVAL_MS,
      nextPrice: () => {
        return takeNext(queued);
      },
    }),
    produce: async (price: Price): Promise<void> => {
      queued.push(price);
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    },
    teardown: (): void => {
      queued.length = 0;
    },
  };
});

/** The simulator ticks once for each price the contract produces, so one is always waiting. */
function takeNext(queued: Price[]): Price {
  const next = queued.shift();

  if (next === undefined) {
    throw new Error(
      "the simulator asked for a price the contract had not produced",
    );
  }

  return next;
}
