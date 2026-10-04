import { defer, map, type Observable, timer } from "rxjs";

import type { Price } from "../entities/price.ts";
import type { PricePort } from "../ports/pricePort.ts";

export interface PriceSimulatorOptions {
  /** How often a price is produced. */
  intervalMs?: number;
  /** Supplies the next price. Defaults to a random walk over a few symbols. */
  nextPrice?: () => Price;
}

const OPENING_MIDS: Record<string, number> = {
  EURUSD: 1.0842,
  GBPUSD: 1.2671,
  USDJPY: 151.32,
};

/**
 * A price source that needs no server. This is production code, not a test
 * double: the app runs on it when no server URL is configured.
 */
export function createPriceSimulator({
  intervalMs = 500,
  nextPrice = createRandomWalk(),
}: PriceSimulatorOptions = {}): PricePort {
  return {
    prices: (): Observable<Price> => defer(() => timer(intervalMs, intervalMs).pipe(map(() => nextPrice()))),
  };
}

/** Each call moves one symbol by at most 0.1% and returns its new price. */
export function createRandomWalk(random: () => number = Math.random): () => Price {
  const mids = new Map(Object.entries(OPENING_MIDS));
  const symbols = [...mids.keys()];

  return (): Price => {
    const symbol = symbols[Math.floor(random() * symbols.length)] ?? symbols[0]!;
    const mid = roundToPips((mids.get(symbol) ?? 1) * (1 + (random() * 2 - 1) * 0.001));

    mids.set(symbol, mid);

    return { symbol, mid };
  };
}

function roundToPips(mid: number): number {
  return Math.round(mid * 10_000) / 10_000;
}
