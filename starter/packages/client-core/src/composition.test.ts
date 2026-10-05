import { Subject } from "rxjs";
import { describe, expect, it } from "vitest";

import type { Price } from "@app/domain";

import { createApp } from "./composition.ts";

describe("the application", () => {
  it("shows the prices its price port produces", () => {
    const prices$ = new Subject<Price>();
    const app = createApp({ price: { prices: () => prices$ } });
    const subscription = app.presenters.prices.rows$.subscribe();

    prices$.next({ symbol: "EURUSD", mid: 1.1 });

    expect(app.presenters.prices.rows$.getValue().map((row) => row.symbol)).toEqual(["EURUSD"]);

    subscription.unsubscribe();
  });

  it("builds a separate selection machine for each component that asks", () => {
    const app = createApp({ price: { prices: () => new Subject<Price>() } });
    const first = app.machines.createSelection();
    const second = app.machines.createSelection();

    first.intents.select("EURUSD");

    expect(first.state$.getValue()).toEqual({ selected: "EURUSD" });
    expect(second.state$.getValue()).toEqual({ selected: null });

    first.dispose();
    second.dispose();
  });
});
