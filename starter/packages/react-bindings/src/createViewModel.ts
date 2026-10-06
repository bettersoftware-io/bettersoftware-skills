import { useStateObservable } from "@react-rxjs/core";

import type {
  App,
  PriceRow,
  SelectionIntents,
  SelectionState,
} from "@app/client-core";

import { type MachineView, useMachine } from "./useMachine.ts";

/**
 * Everything the UI can read or do, as hooks. This is the UI's only door to
 * the application: a component never sees a stream, a port or an adapter.
 */
export interface ViewModel {
  usePrices: () => PriceRow[];
  useSelection: () => MachineView<SelectionState, SelectionIntents>;
}

/** Built once at startup, in the composition root, from the application. */
export function createViewModel(app: App): ViewModel {
  return {
    usePrices: (): PriceRow[] =>
      useStateObservable(app.presenters.prices.rows$),
    useSelection: (): MachineView<SelectionState, SelectionIntents> =>
      useMachine(app.machines.createSelection),
  };
}
