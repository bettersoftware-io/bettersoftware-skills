import { expect, test } from "#/testing/test.ts";

test.describe("selecting a row", () => {
  test("marks the row that is clicked, keeps it through newer prices, and clears it on a second click", async ({
    priceList,
  }) => {
    await priceList.open();
    await expect.poll(priceList.rows).not.toEqual([]);

    const [{ symbol }] = await priceList.rows();

    await priceList.clickRow(symbol);
    await expect.poll(priceList.selectedSymbol).toBe(symbol);

    const whenSelected = await priceList.rows();

    await expect.poll(priceList.rows).not.toEqual(whenSelected);
    expect(await priceList.selectedSymbol()).toBe(symbol);

    await priceList.clickRow(symbol);
    await expect.poll(priceList.selectedSymbol).toBeNull();
  });
});
