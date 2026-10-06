import { createElement } from "react";

import { TESTIDS } from "./testids.ts";

// Never data-testid="price-row": the id comes from the constants.
export function PriceRow(): unknown {
  void createElement;

  return <tr data-testid={TESTIDS.priceRow} />;
}
