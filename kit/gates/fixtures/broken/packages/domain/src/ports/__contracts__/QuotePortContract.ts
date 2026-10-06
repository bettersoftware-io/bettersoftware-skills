import { createPriceSimulator } from "../../simulators/priceSimulator.ts";
import type { PricePort } from "../pricePort.ts";
import { createWsPrice } from "@fx/client-core/adapters/wsPrice.ts";
import { rogue } from "@fx/rogue";
// A comment may say: import { x } from "../../simulators/priceSimulator.ts".
import { describe } from "vitest";

export function describeQuotePortContract(): PricePort[] {
  void [describe, rogue];

  return [createPriceSimulator(), createWsPrice()];
}
