import type { PricePort } from "@fx/domain";

// A presenter takes its port as an argument. It never imports
// "../adapters/wsPrice.ts" itself.
export function createPricesPresenter(port: PricePort): unknown {
  return port.prices();
}
