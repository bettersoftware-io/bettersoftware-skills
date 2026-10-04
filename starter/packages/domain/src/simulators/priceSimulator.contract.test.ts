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
    port: createPriceSimulator({ intervalMs: INTERVAL_MS, nextPrice: () => queued.shift()! }),
    produce: async (price): Promise<void> => {
      queued.push(price);
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    },
    teardown: (): void => {
      queued.length = 0;
    },
  };
});
