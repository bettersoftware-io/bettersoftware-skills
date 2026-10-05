import type { Observable } from "rxjs";

export interface Price {
  symbol: string;
  mid: number;
}

export interface PricePort {
  /** Every price, as it changes. */
  prices(): Observable<Price>;
  // A property that holds a function is a method too.
  latest: (symbol: string) => Observable<Price>;
  /** Not something to call: a contract cannot be asked to. */
  readonly name: string;
  /** A parenthesised type is not a function. */
  readonly sides: ("bid" | "ask")[];
}
