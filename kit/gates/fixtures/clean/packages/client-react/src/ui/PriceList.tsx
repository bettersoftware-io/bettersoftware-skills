// A timer here would be wrong: setTimeout belongs in a machine.
import { usePrices } from "./viewModel/usePrices.ts";

export function PriceList(): unknown {
  return usePrices as unknown;
}
