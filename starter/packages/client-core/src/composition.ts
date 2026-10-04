import type { PricePort } from "@app/domain";

import type { Machine } from "./machines/machine.ts";
import { createSelectionMachine, type SelectionIntents, type SelectionState } from "./machines/selectionMachine.ts";
import { createPricesPresenter, type PricesPresenter } from "./presenters/pricesPresenter.ts";

/** Everything the application needs from the outside world. The client's
 * composition root decides what stands behind each port. */
export interface AppPorts {
  price: PricePort;
}

/** The application, built once at startup. Presenters are shared; machine
 * factories build one machine per component that asks. */
export interface App {
  presenters: {
    prices: PricesPresenter;
  };
  machines: {
    createSelection: () => Machine<SelectionState, SelectionIntents>;
  };
}

export function createApp(ports: AppPorts): App {
  return {
    presenters: {
      prices: createPricesPresenter(ports.price),
    },
    machines: {
      createSelection: createSelectionMachine,
    },
  };
}
