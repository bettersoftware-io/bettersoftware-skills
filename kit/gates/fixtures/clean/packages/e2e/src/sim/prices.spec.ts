import { test } from "#/testing/test.ts";

test("lists a price", async ({ priceList }) => {
  await priceList.rowCount();
});
