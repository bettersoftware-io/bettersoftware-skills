import type { PricePort } from "@fx/domain";

import { createPricesPresenter } from "./presenters/pricesPresenter.ts";

export interface AppPorts {
  price: PricePort;
}

export interface App {
  prices: unknown;
}

export function createApp(ports: AppPorts): App {
  return { prices: createPricesPresenter(ports.price) };
}
