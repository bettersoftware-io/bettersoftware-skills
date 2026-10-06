import { createWsPrice } from "#/adapters/wsPrice.ts";
import { type App, createApp } from "../composition.ts";

/** The one place a test builds the whole application. */
export function createAppHarness(): App {
  return createApp({ price: createWsPrice() });
}
