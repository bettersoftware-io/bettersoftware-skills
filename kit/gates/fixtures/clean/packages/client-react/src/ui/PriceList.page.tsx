import { createAppHarness } from "@fx/client-core/testing/appHarness.ts";

import { PriceList } from "./PriceList.tsx";
import { TESTIDS } from "./testids.ts";

interface Screen {
  getByTestId: (id: string) => unknown;
  queryAllByTestId: (id: string) => unknown[];
  querySelector: (selector: string) => unknown;
}

// A page object asks by constant, never getByTestId("price-list").
export function mountPriceList(screen: Screen): unknown[] {
  void createAppHarness();
  void PriceList;
  void screen.getByTestId(TESTIDS.priceList);
  // A selector built from the constant holds no id of its own.
  void screen.querySelector(`[data-testid="${TESTIDS.priceRow}"]`);

  return screen.queryAllByTestId(TESTIDS.priceRow);
}
