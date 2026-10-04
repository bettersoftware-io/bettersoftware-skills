import type { Observable } from "rxjs";

import type { Price } from "../entities/price.ts";

/**
 * Where prices come from. The domain declares this; a simulator and a real
 * transport each implement it, and the composition root picks one.
 *
 * Each subscription is its own feed, and it ends when unsubscribed.
 */
export interface PricePort {
  prices(): Observable<Price>;
}
