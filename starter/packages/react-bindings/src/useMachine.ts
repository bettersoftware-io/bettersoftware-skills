import type { Machine } from "@app/client-core";
import { useStateObservable } from "@react-rxjs/core";
import { useEffect, useRef } from "react";

export type MachineView<TState, TIntents> = { state: TState } & TIntents;

/**
 * One machine per component instance: built on first render, disposed on
 * unmount. Returns the current state and the intents.
 *
 * Disposal is deferred by a microtask. React's StrictMode runs an effect's
 * setup, cleanup and setup again in one go on mount; disposing in that cleanup
 * would leave the component holding a dead machine. The second setup cancels
 * the pending disposal, and a real unmount, which has no second setup, lets it
 * run.
 */
export function useMachine<TState, TIntents extends object>(
  createMachine: () => Machine<TState, TIntents>,
): MachineView<TState, TIntents> {
  const ref = useRef<Machine<TState, TIntents> | null>(null);

  if (ref.current === null) {
    ref.current = createMachine();
  }

  const machine = ref.current;
  const keepAlive = useRef(true);

  useEffect(() => {
    keepAlive.current = true;

    return (): void => {
      keepAlive.current = false;
      queueMicrotask(() => {
        if (!keepAlive.current) {
          machine.dispose();
          ref.current = null;
        }
      });
    };
  }, [machine]);

  const state = useStateObservable(machine.state$);

  return { state, ...machine.intents };
}
