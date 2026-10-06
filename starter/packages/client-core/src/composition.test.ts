import { describe, expect, it } from "vitest";

import { createAppHarness } from "./testing/appHarness.ts";

describe("the application", () => {
  it("shows the prices its price port produces", () => {
    const { app, deliverPrice } = createAppHarness();
    const subscription = app.presenters.prices.rows$.subscribe();

    deliverPrice({ symbol: "EURUSD", mid: 1.1 });

    expect(
      app.presenters.prices.rows$.getValue().map((row) => {
        return row.symbol;
      }),
    ).toEqual(["EURUSD"]);

    subscription.unsubscribe();
  });

  it("builds a separate selection machine for each component that asks", () => {
    const { app } = createAppHarness();
    const first = app.machines.createSelection();
    const second = app.machines.createSelection();

    first.intents.select("EURUSD");

    expect(first.state$.getValue()).toEqual({ selected: "EURUSD" });
    expect(second.state$.getValue()).toEqual({ selected: null });

    first.dispose();
    second.dispose();
  });
});
