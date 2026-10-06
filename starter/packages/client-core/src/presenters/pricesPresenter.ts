import { type DefaultedStateObservable, state } from "@rx-state/core";
import {
  concat,
  groupBy,
  map,
  mergeMap,
  type Observable,
  of,
  scan,
  switchMap,
  timer,
} from "rxjs";

import {
  type Movement,
  type PricePort,
  type PriceTick,
  trackMovement,
} from "@app/domain";

/** How long a symbol can go without a price before its row is shown as stale. */
export const STALE_AFTER_MS = 5000;

/** One row of the price list, ready to render: nothing is left for the UI to work out. */
export interface PriceRow {
  symbol: string;
  mid: number;
  movement: Movement;
  stale: boolean;
}

export interface PricesPresenter {
  /** Every known symbol's row, in symbol order. Shared: one feed, however many readers. */
  rows$: DefaultedStateObservable<PriceRow[]>;
}

export function createPricesPresenter(port: PricePort): PricesPresenter {
  const rows$ = trackMovement(port.prices()).pipe(
    groupBy((tick) => tick.symbol),
    // Within one symbol, a new tick restarts the wait that marks the row stale.
    mergeMap((ticksOfSymbol$) => ticksOfSymbol$.pipe(switchMap(showThenAge))),
    scan(
      (rows, row) => new Map(rows).set(row.symbol, row),
      new Map<string, PriceRow>(),
    ),
    map((rows) =>
      [...rows.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)),
    ),
  );

  return { rows$: state(rows$, []) };
}

/** The row as fresh now, and again as stale if nothing replaces it in time. */
function showThenAge(tick: PriceTick): Observable<PriceRow> {
  return concat(
    of({ ...tick, stale: false }),
    timer(STALE_AFTER_MS).pipe(map(() => ({ ...tick, stale: true }))),
  );
}
