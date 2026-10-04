import type { DefaultedStateObservable } from "@rx-state/core";

/**
 * State that belongs to one component instance and changes on intents. The
 * logic is a pure reducer; the bindings create one machine per mount and
 * dispose it on unmount.
 */
export interface Machine<TState, TIntents extends object> {
  state$: DefaultedStateObservable<TState>;
  intents: TIntents;
  dispose: () => void;
}
