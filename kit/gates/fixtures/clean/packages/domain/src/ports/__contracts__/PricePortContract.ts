import type { PricePort } from "../pricePort.ts";

export function describePricePortContract(label: string, createPort: () => PricePort): void {
  void label;
  void createPort;
}
