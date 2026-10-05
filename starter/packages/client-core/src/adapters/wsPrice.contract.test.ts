import { Subject } from "rxjs";

import type { Price } from "@app/domain";
import { describePricePortContract } from "@app/domain/ports/__contracts__/PricePortContract.ts";
import { encodePrice } from "@app/shared";

import { createWsPricePort } from "./wsPrice.ts";

describePricePortContract("WebSocket price adapter", () => {
  const messages$ = new Subject<unknown>();

  return {
    port: createWsPricePort({ messages: () => messages$ }),
    produce: (price: Price): void => {
      messages$.next(encodePrice(price));
    },
    teardown: (): void => {
      messages$.complete();
    },
  };
});
