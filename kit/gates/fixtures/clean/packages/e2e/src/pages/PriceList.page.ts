import type { Page } from "@playwright/test";

// The one file of the application an e2e package may import.
import { TESTIDS } from "@fx/client-react/ui/testids.ts";
// A type is not an edge.
import type { Price } from "@fx/domain";

export interface PriceListPage {
  rowCount: () => Promise<number>;
  shown: () => Promise<Price[]>;
}

export function createPriceListPage(page: Page): PriceListPage {
  return {
    rowCount: () => page.getByTestId(TESTIDS.priceRow).count(),
    shown: async () => [],
  };
}
