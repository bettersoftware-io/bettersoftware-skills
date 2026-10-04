import type { Price, PricePort } from "@app/domain";
import { decodePrice, parseServerMessage } from "@app/shared";
import { filter, map, type Observable } from "rxjs";

import type { WsConnection } from "./wsConnection.ts";

/**
 * The real PricePort: prices from a server. This is where the wire format is
 * turned into domain terms; nothing past this adapter sees a wire message.
 * A message the protocol does not know is dropped.
 */
export function createWsPricePort(connection: WsConnection): PricePort {
  return {
    prices: (): Observable<Price> =>
      connection.messages().pipe(
        map(parseServerMessage),
        filter((message) => message !== undefined),
        map((message) => decodePrice(message.payload)),
      ),
  };
}
