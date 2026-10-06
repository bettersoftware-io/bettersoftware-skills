import { describe, expect, it } from "vitest";

import type { Price } from "#/entities/price.ts";

import type { PricePort } from "../pricePort.ts";

/** What an adapter's test supplies so the contract can drive it. */
export interface PricePortHarness {
  port: PricePort;
  /** Makes the adapter's source produce this price. */
  produce: (price: Price) => void | Promise<void>;
  teardown: () => void;
}

/**
 * The behaviour every PricePort adapter owes its callers. Each adapter's test
 * calls this with its own harness; an adapter that passes is interchangeable
 * with the others.
 */
export function describePricePortContract(
  label: string,
  createHarness: () => PricePortHarness,
): void {
  describe(`${label} :: PricePort contract`, () => {
    it("delivers every price the source produces, in order", async () => {
      const { port, produce, teardown } = createHarness();
      const received: Price[] = [];
      const subscription = port.prices().subscribe((price) => {
        return received.push(price);
      });

      try {
        await produce({ symbol: "EURUSD", mid: 1.1 });
        await produce({ symbol: "GBPUSD", mid: 1.25 });
        await produce({ symbol: "EURUSD", mid: 1.2 });

        expect(received).toEqual([
          { symbol: "EURUSD", mid: 1.1 },
          { symbol: "GBPUSD", mid: 1.25 },
          { symbol: "EURUSD", mid: 1.2 },
        ]);
      } finally {
        subscription.unsubscribe();
        teardown();
      }
    });

    it("delivers nothing after the subscriber leaves", async () => {
      const { port, produce, teardown } = createHarness();
      const received: Price[] = [];
      const subscription = port.prices().subscribe((price) => {
        return received.push(price);
      });

      try {
        await produce({ symbol: "EURUSD", mid: 1.1 });
        subscription.unsubscribe();
        await produce({ symbol: "EURUSD", mid: 1.2 });

        expect(received).toEqual([{ symbol: "EURUSD", mid: 1.1 }]);
      } finally {
        teardown();
      }
    });

    it("starts a new subscriber from now, with no replay of earlier prices", async () => {
      const { port, produce, teardown } = createHarness();
      const received: Price[] = [];
      const first = port.prices().subscribe();

      try {
        await produce({ symbol: "EURUSD", mid: 1.1 });
        first.unsubscribe();

        const second = port.prices().subscribe((price) => {
          return received.push(price);
        });

        await produce({ symbol: "EURUSD", mid: 1.2 });
        second.unsubscribe();

        expect(received).toEqual([{ symbol: "EURUSD", mid: 1.2 }]);
      } finally {
        teardown();
      }
    });
  });
}
