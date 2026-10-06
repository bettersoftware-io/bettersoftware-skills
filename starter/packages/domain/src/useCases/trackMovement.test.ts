import { Subject } from "rxjs";
import { describe, expect, it } from "vitest";

import type { Price, PriceTick } from "../entities/price.ts";
import { trackMovement } from "./trackMovement.ts";

describe("trackMovement", () => {
  it("marks the first price of a symbol as flat", () => {
    const { prices$, ticks } = createTracked();

    prices$.next({ symbol: "EURUSD", mid: 1.1 });

    expect(ticks).toEqual([{ symbol: "EURUSD", mid: 1.1, movement: "flat" }]);
  });

  it("compares each price with the previous one for the same symbol only", () => {
    const { prices$, ticks } = createTracked();

    prices$.next({ symbol: "EURUSD", mid: 1.1 });
    prices$.next({ symbol: "GBPUSD", mid: 1.3 });
    prices$.next({ symbol: "EURUSD", mid: 1.2 });
    prices$.next({ symbol: "GBPUSD", mid: 1.2 });
    prices$.next({ symbol: "EURUSD", mid: 1.2 });

    expect(
      ticks.map((tick) => {
        return tick.movement;
      }),
    ).toEqual(["flat", "flat", "up", "down", "flat"]);
  });

  it("gives each subscription its own memory", () => {
    const prices$ = new Subject<Price>();
    const tracked$ = trackMovement(prices$);
    const early: PriceTick[] = [];
    const late: PriceTick[] = [];

    tracked$.subscribe((tick) => {
      return early.push(tick);
    });
    prices$.next({ symbol: "EURUSD", mid: 1.1 });
    tracked$.subscribe((tick) => {
      return late.push(tick);
    });
    prices$.next({ symbol: "EURUSD", mid: 1.2 });

    expect(early.at(-1)?.movement).toBe("up");
    expect(late.at(-1)?.movement).toBe("flat");
  });
});

interface Tracked {
  prices$: Subject<Price>;
  ticks: PriceTick[];
}

function createTracked(): Tracked {
  const prices$ = new Subject<Price>();
  const ticks: PriceTick[] = [];

  trackMovement(prices$).subscribe((tick) => {
    return ticks.push(tick);
  });

  return { prices$, ticks };
}
