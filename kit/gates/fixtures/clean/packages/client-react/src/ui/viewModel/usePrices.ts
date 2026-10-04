import type { Observable } from "rxjs";

export function usePrices(prices$: Observable<number>): number[] {
  void prices$;

  return [];
}
