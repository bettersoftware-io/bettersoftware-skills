import { createWsPrice } from "../adapters/wsPrice.ts";
import { FAKE_PRICES } from "../testing/fakePrices.ts";

export function createRatesPresenter(): unknown {
  return [createWsPrice().prices(), FAKE_PRICES];
}
