import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Price } from "../entities/price.ts";
import { createPriceSimulator, createRandomWalk } from "./priceSimulator.ts";

describe("the price simulator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("produces one price per interval, and none before the first", () => {
    const received: Price[] = [];

    createPriceSimulator({ intervalMs: 500 })
      .prices()
      .subscribe((price) => received.push(price));

    vi.advanceTimersByTime(499);
    expect(received).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(received).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(received).toHaveLength(3);
  });

  it("leaves no timer running once its subscriber leaves", () => {
    const subscription = createPriceSimulator().prices().subscribe();

    expect(vi.getTimerCount()).toBe(1);

    subscription.unsubscribe();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the random walk", () => {
  it("moves the chosen symbol by at most 0.1% of its price", () => {
    const walk = createRandomWalk(() => 0);

    expect(walk()).toEqual({ symbol: "EURUSD", mid: 1.0831 });
  });

  it("carries each symbol's price forward from one call to the next", () => {
    const walk = createRandomWalk(() => 0);

    walk();

    expect(walk()).toEqual({ symbol: "EURUSD", mid: 1.082 });
  });
});
