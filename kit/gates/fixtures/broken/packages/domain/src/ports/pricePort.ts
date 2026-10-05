import type { Observable } from "rxjs";

export interface Price {
  symbol: string;
  mid: number;
}

export interface PricePort {
  prices(): Observable<Price>;
  history(symbol: string): Observable<Price[]>;
  latest: (symbol: string) => Observable<Price>;
}
