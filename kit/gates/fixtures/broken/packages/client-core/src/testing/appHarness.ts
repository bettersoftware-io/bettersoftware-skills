import { createWsPrice } from "../adapters/wsPrice.ts";
import { type AppPorts, createApp } from "../composition.ts";

export function createAppHarness(): AppPorts {
  return createApp({ price: createWsPrice() });
}
