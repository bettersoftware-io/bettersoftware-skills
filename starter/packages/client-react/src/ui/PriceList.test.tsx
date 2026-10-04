import { describe, expect, it } from "vitest";

import { mountPriceList } from "./PriceList.page.tsx";

describe("the price list", () => {
  it("is empty before any price arrives", () => {
    const page = mountPriceList();

    expect(page.symbols()).toEqual([]);
  });

  it("lists each symbol once, in symbol order", () => {
    const page = mountPriceList();

    page.showPrice({ symbol: "GBPUSD", mid: 1.25 });
    page.showPrice({ symbol: "EURUSD", mid: 1.1 });
    page.showPrice({ symbol: "GBPUSD", mid: 1.26 });

    expect(page.symbols()).toEqual(["EURUSD", "GBPUSD"]);
  });

  it("shows which way a price moved", () => {
    const page = mountPriceList();

    page.showPrice({ symbol: "EURUSD", mid: 1.1 });
    expect(page.movementOf("EURUSD")).toBe("flat");

    page.showPrice({ symbol: "EURUSD", mid: 1.2 });
    expect(page.movementOf("EURUSD")).toBe("up");

    page.showPrice({ symbol: "EURUSD", mid: 1.15 });
    expect(page.movementOf("EURUSD")).toBe("down");
  });

  it("selects the row that is clicked, and clears it when clicked again", async () => {
    const page = mountPriceList();

    page.showPrice({ symbol: "EURUSD", mid: 1.1 });
    page.showPrice({ symbol: "GBPUSD", mid: 1.25 });

    await page.clickRow("GBPUSD");
    expect(page.selectedSymbol()).toBe("GBPUSD");

    await page.clickRow("GBPUSD");
    expect(page.selectedSymbol()).toBeNull();
  });
});
