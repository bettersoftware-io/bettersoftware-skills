import { defer, map, type Observable } from "rxjs";

import type { Movement, Price, PriceTick } from "../entities/price.ts";

/**
 * Adds to each price the way it moved against the previous price for the same
 * symbol. The memory of previous prices lives inside `defer`, so every
 * subscription starts with its own.
 */
export function trackMovement(
  prices$: Observable<Price>,
): Observable<PriceTick> {
  return defer(() => {
    const previous = new Map<string, number>();

    return prices$.pipe(
      map((price) => {
        const before = previous.get(price.symbol);

        previous.set(price.symbol, price.mid);

        return { ...price, movement: compareWithPrevious(before, price.mid) };
      }),
    );
  });
}

function compareWithPrevious(
  before: number | undefined,
  mid: number,
): Movement {
  if (before === undefined || before === mid) {
    return "flat";
  }

  return mid > before ? "up" : "down";
}
