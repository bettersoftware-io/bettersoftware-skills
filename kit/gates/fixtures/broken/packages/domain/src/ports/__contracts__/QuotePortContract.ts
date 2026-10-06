import { createPriceSimulator } from "../../simulators/priceSimulator.ts";
import type { PricePort } from "../pricePort.ts";
import { createWsPrice } from "@fx/client-core/adapters/wsPrice.ts";
import { rogue } from "@fx/rogue";
// A comment may say: import { x } from "../../simulators/priceSimulator.ts".
import { describe } from "vitest";
import { createPriceSimulator as createAliased } from "#/simulators/priceSimulator.ts";

export function describeQuotePortContract(): PricePort[] {
  void [describe, rogue, createAliased];

  return [createPriceSimulator(), createWsPrice()];
}
