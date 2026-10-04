import { of } from "rxjs";

import type { PricePort } from "../ports/pricePort.ts";

export function createPriceSimulator(): PricePort {
  return { prices: () => of({ symbol: "EURUSD", mid: 1.1 }) };
}
