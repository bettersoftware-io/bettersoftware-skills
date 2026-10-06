import { createWsPrice } from "#/adapters/wsPrice.ts";
import { FAKE_PRICES } from "#/testing/fakePrices.ts";

// The same two imports as ratesPresenter.ts, written through the package's
// `#/` alias. A rule that reads paths must still see where they land.
export function createAliasedPresenter(): unknown {
  return [createWsPrice().prices(), FAKE_PRICES];
}
