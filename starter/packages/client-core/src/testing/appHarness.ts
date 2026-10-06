import { Subject } from "rxjs";

import type { Price } from "@app/domain";

import { type App, createApp } from "../composition.ts";

/** The real application on ports a test drives by hand. */
export interface AppHarness {
  app: App;
  /** Delivers a price as if the source had produced it. */
  deliverPrice: (price: Price) => void;
}

/**
 * For tests above the core (bindings, UI): everything real except the outside
 * world. Lives here so those tests need no stream library of their own.
 */
export function createAppHarness(): AppHarness {
  const prices$ = new Subject<Price>();

  return {
    app: createApp({
      price: {
        prices: () => {
          return prices$;
        },
      },
    }),
    deliverPrice: (price: Price): void => {
      prices$.next(price);
    },
  };
}
