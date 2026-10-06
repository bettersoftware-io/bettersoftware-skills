import type { App as Application } from "@app/client-core";
import { STALE_AFTER_MS } from "@app/client-core/presenters/pricesPresenter.ts";
import {
  type AppHarness,
  createAppHarness,
} from "@app/client-core/testing/appHarness.ts";

import type { HostClock, Seeded } from "./host/seeded.ts";
import type { Scenario } from "./scenarios.ts";

// How a scenario's data becomes app state. This file is the project's: when a
// feature adds a field to `Scenario`, the lines that deliver it go here. The
// host (`host/`) belongs to the add-on and never needs an edit for a feature:
// it owns the clock, calls `deliver` once the UI has subscribed, and says when
// the picture may be taken.
//
// Two places to put state, and a rule for choosing:
//
// - `app`: what must be true before the first render. A port that answers
//   from memory is given its data when the harness is built; a machine is
//   wrapped so that each one built already holds the scenario's value, set
//   through its own intent.
// - `deliver`: what arrives after the UI is on screen, in order. A wait is
//   `clock.tick(...)`, never a real one.

/** The application and the deliveries of one scenario. Called once, before the first render. */
export function seedScenario(scenario: Scenario, clock: HostClock): Seeded {
  const harness = createAppHarness();

  return {
    app: selectFromTheStart(harness.app, scenario.selected),
    deliver: () => {
      deliverAll(harness, scenario.stalePrices ?? []);

      if (scenario.stalePrices !== undefined) {
        clock.tick(STALE_AFTER_MS);
      }

      deliverAll(harness, scenario.prices);
    },
  };
}

function deliverAll(
  { deliverPrice }: AppHarness,
  prices: Scenario["prices"],
): void {
  for (const price of prices) {
    deliverPrice(price);
  }
}

/**
 * The application, with every selection machine it builds already holding the
 * scenario's selection. The selection is set through the machine's own intent,
 * so the picture shows what a click would have produced without a click.
 */
function selectFromTheStart(
  app: Application,
  symbol: string | undefined,
): Application {
  if (symbol === undefined) {
    return app;
  }

  return {
    ...app,
    machines: {
      ...app.machines,
      createSelection: () => {
        const machine = app.machines.createSelection();

        machine.intents.select(symbol);

        return machine;
      },
    },
  };
}
