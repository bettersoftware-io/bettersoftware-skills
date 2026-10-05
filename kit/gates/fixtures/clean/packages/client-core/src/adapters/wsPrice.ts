import type { PricePort } from "@fx/domain";
import { EMPTY } from "rxjs";

export function createWsPrice(): PricePort {
  return { prices: () => EMPTY, latest: () => EMPTY, name: "ws", sides: ["bid", "ask"] };
}
