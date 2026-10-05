import { state } from "@rx-state/core";
import { map, merge, Subject, scan } from "rxjs";

import type { Machine } from "./machine.ts";

export interface SelectionState {
  selected: string | null;
}

export interface SelectionIntents {
  /** Selects the symbol, or clears the selection if it is already selected. */
  select: (symbol: string) => void;
  clear: () => void;
}

type SelectionAction = { type: "select"; symbol: string } | { type: "clear" };

const INITIAL: SelectionState = { selected: null };

export function reduceSelection(current: SelectionState, action: SelectionAction): SelectionState {
  if (action.type === "clear" || current.selected === action.symbol) {
    return INITIAL;
  }

  return { selected: action.symbol };
}

/** Which row is selected. Subjects in, one reducer, one state stream out. */
export function createSelectionMachine(): Machine<SelectionState, SelectionIntents> {
  const select$ = new Subject<string>();
  const clear$ = new Subject<void>();

  const state$ = state(
    merge(
      select$.pipe(map((symbol): SelectionAction => ({ type: "select", symbol }))),
      clear$.pipe(map((): SelectionAction => ({ type: "clear" }))),
    ).pipe(scan(reduceSelection, INITIAL)),
    INITIAL,
  );

  // Held open for the machine's whole life, so an intent sent before the UI
  // subscribes is not lost.
  const subscription = state$.subscribe();

  return {
    state$,
    intents: {
      select: (symbol: string): void => {
        select$.next(symbol);
      },
      clear: (): void => {
        clear$.next();
      },
    },
    dispose: (): void => {
      subscription.unsubscribe();
      select$.complete();
      clear$.complete();
    },
  };
}
