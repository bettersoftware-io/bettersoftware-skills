import type { PricePort } from "../pricePort.ts";

export function describePricePortContract(label: string, createPort: () => PricePort): void {
  const port = createPort();

  void label;
  void port.prices();
  void port.latest("EURUSD");
}
