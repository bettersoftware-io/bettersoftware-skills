import { createWsPrice } from "@fx/client-core";

export function createViewModel(): { priceSource: unknown } {
  return { priceSource: createWsPrice() };
}
