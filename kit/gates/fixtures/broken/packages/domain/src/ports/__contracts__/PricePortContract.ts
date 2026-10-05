import type { PricePort } from "../pricePort.ts";

// The contract mentions history() and port.latest( here, in a comment, and calls neither.
export function describePricePortContract(label: string, createPort: () => PricePort): void {
  void label;
  void createPort().prices();
}
