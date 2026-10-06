import { expect, test } from "#/testing/test.ts";

test.describe("the price list, on the simulator", () => {
  test("shows a row for each price the feed produces, as a symbol and a mid to four decimals", async ({
    priceList,
  }) => {
    await priceList.open();

    await expect.poll(priceList.rows).not.toEqual([]);

    for (const row of await priceList.rows()) {
      expect(row.symbol).toMatch(/^[A-Z]{6}$/);
      expect(row.mid).toMatch(/^\d+\.\d{4}$/);
    }
  });

  test("replaces the mid of a row when a newer price arrives for its symbol", async ({
    priceList,
  }) => {
    await priceList.open();
    await expect.poll(priceList.rows).not.toEqual([]);

    const [first] = await priceList.rows();

    await expect
      .poll(() => {
        return priceList.midOf(first.symbol);
      }, A_ROW_CHANGES)
      .not.toBe(first.mid);
  });

  test("opens no connection: the prices are the browser's own", async ({
    priceList,
    serverFeed,
  }) => {
    await priceList.open();
    await expect.poll(priceList.rows).not.toEqual([]);

    expect(serverFeed.connections()).toEqual([]);
  });
});

// The simulator moves one of three symbols every half second, by a random
// amount. A wait for one given row to change is therefore a wait on chance: a
// tick moves it about one time in three. Sixty ticks leave about one failure
// in ten thousand million runs, and the usual wait is under two seconds.
const A_ROW_CHANGES = { timeout: 30_000 };
