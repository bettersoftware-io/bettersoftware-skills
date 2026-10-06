import { expect, test } from "#/testing/test.ts";

test.describe("the price list, against the real server", () => {
  test("shows the prices the server sent, and no others", async ({
    priceList,
    serverFeed,
  }) => {
    await priceList.open();

    // Read off the wire on one side and off the screen on the other. A client
    // that fell back to its simulator would open no socket, and its rows
    // would match nothing the server sent.
    await expect(async () => {
      expect(serverFeed.latestSent()).not.toEqual([]);
      expect(
        (await priceList.rows()).map(({ symbol, mid }) => {
          return { symbol, mid };
        }),
      ).toEqual(serverFeed.latestSent());
    }).toPass({ timeout: 10_000 });

    expect(serverFeed.connections()).toHaveLength(1);
  });
});
