import { describe } from "vitest";

import type { PricePort } from "../pricePort.ts";

// A contract is handed the implementation. It never writes
// import { createPriceSimulator } from "../../simulators/priceSimulator.ts".
export function describePricePortContract(label: string, createPort: () => PricePort): void {
  const port = createPort();

  void describe;
  void label;
  void port.prices();
  void port.latest("EURUSD");
}
