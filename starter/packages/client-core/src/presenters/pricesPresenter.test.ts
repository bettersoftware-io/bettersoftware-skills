import { Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Price } from "@app/domain";

import { createPricesPresenter, type PriceRow, STALE_AFTER_MS } from "./pricesPresenter.ts";

describe("the prices presenter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("has no rows before the first price", () => {
    const { latest } = createPresented();

    expect(latest()).toEqual([]);
  });

  it("keeps one row per symbol, in symbol order, with the way each price moved", () => {
    const { prices$, latest } = createPresented();

    prices$.next({ symbol: "GBPUSD", mid: 1.25 });
    prices$.next({ symbol: "EURUSD", mid: 1.1 });
    prices$.next({ symbol: "GBPUSD", mid: 1.24 });

    expect(latest()).toEqual([
      { symbol: "EURUSD", mid: 1.1, movement: "flat", stale: false },
      { symbol: "GBPUSD", mid: 1.24, movement: "down", stale: false },
    ]);
  });

  it("marks a row stale once its symbol has had no price for five seconds", () => {
    const { prices$, latest } = createPresented();

    prices$.next({ symbol: "EURUSD", mid: 1.1 });

    vi.advanceTimersByTime(STALE_AFTER_MS - 1);
    expect(latest()[0]?.stale).toBe(false);

    vi.advanceTimersByTime(1);
    expect(latest()[0]?.stale).toBe(true);
  });

  it("times each symbol from its own last price", () => {
    const { prices$, latest } = createPresented();

    prices$.next({ symbol: "EURUSD", mid: 1.1 });
    vi.advanceTimersByTime(3000);
    prices$.next({ symbol: "GBPUSD", mid: 1.25 });
    vi.advanceTimersByTime(2000);

    expect(latest().map((row) => row.stale)).toEqual([true, false]);
  });

  it("makes a stale row fresh again when a price arrives", () => {
    const { prices$, latest } = createPresented();

    prices$.next({ symbol: "EURUSD", mid: 1.1 });
    vi.advanceTimersByTime(STALE_AFTER_MS);
    prices$.next({ symbol: "EURUSD", mid: 1.2 });

    expect(latest()).toEqual([{ symbol: "EURUSD", mid: 1.2, movement: "up", stale: false }]);
  });

  it("opens one feed however many readers there are, and closes it when the last leaves", () => {
    let feeds = 0;
    const prices$ = new Subject<Price>();
    const presenter = createPricesPresenter({
      prices: () => {
        feeds += 1;

        return prices$;
      },
    });

    const first = presenter.rows$.subscribe();
    const second = presenter.rows$.subscribe();

    expect(feeds).toBe(1);

    prices$.next({ symbol: "EURUSD", mid: 1.1 });
    first.unsubscribe();
    second.unsubscribe();

    expect(prices$.observed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

interface Presented {
  prices$: Subject<Price>;
  latest: () => PriceRow[];
}

function createPresented(): Presented {
  const prices$ = new Subject<Price>();
  const presenter = createPricesPresenter({ prices: () => prices$ });
  let rows: PriceRow[] = [];

  presenter.rows$.subscribe((next) => {
    rows = next;
  });

  return { prices$, latest: () => rows };
}
