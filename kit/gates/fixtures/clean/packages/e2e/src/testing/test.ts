import { test as base } from "@playwright/test";

import { createPriceListPage, type PriceListPage } from "../pages/PriceList.page.ts";

interface Fixtures {
  priceList: PriceListPage;
}

export const test = base.extend<Fixtures>({
  priceList: async ({ page }, use) => {
    await use(createPriceListPage(page));
  },
});
