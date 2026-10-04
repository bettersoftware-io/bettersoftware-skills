import type { Machine } from "@app/client-core";
import { act, render } from "@testing-library/react";
import { type ReactElement, StrictMode } from "react";

import { type MachineView, useMachine } from "./useMachine.ts";

export interface MachinePage<TState, TIntents> {
  state: () => TState;
  send: (use: (intents: TIntents) => void) => Promise<void>;
  unmount: () => Promise<void>;
}

interface MountOptions {
  strict?: boolean;
}

/** Mounts a component that does nothing but hold a machine, and reports what it sees. */
export function mountMachine<TState, TIntents extends object>(
  createMachine: () => Machine<TState, TIntents>,
  { strict = false }: MountOptions = {},
): MachinePage<TState, TIntents> {
  let view: MachineView<TState, TIntents> | undefined;

  function Holder(): ReactElement {
    view = useMachine(createMachine);

    return <output />;
  }

  const rendered = render(strict ? <StrictMode><Holder /></StrictMode> : <Holder />);

  function currentView(): MachineView<TState, TIntents> {
    if (view === undefined) {
      throw new Error("the machine holder has not rendered");
    }

    return view;
  }

  return {
    state: (): TState => currentView().state,
    send: async (use): Promise<void> => {
      await act(async () => {
        use(currentView());
      });
    },
    unmount: async (): Promise<void> => {
      await act(async () => {
        rendered.unmount();
      });
    },
  };
}
