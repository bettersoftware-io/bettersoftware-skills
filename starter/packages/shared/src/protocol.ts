import type { Price } from "@app/domain";

/** The path the server listens on. */
export const WS_PATH = "/ws";

const SERVER_MSG = {
  PRICE: "price",
} as const;

/** A price as it travels on the wire. Kept apart from the domain `Price` so
 * the wire format can change without the domain noticing. */
export interface PriceDto {
  symbol: string;
  mid: number;
}

export interface PriceMessage {
  type: typeof SERVER_MSG.PRICE;
  payload: PriceDto;
}

export type ServerMessage = PriceMessage;

export function encodePrice(price: Price): PriceMessage {
  return { type: SERVER_MSG.PRICE, payload: { symbol: price.symbol, mid: price.mid } };
}

export function decodePrice(dto: PriceDto): Price {
  return { symbol: dto.symbol, mid: dto.mid };
}

/** The message, if `raw` is one this protocol knows; otherwise undefined. */
export function parseServerMessage(raw: unknown): ServerMessage | undefined {
  if (!isRecord(raw) || raw.type !== SERVER_MSG.PRICE || !isRecord(raw.payload)) {
    return undefined;
  }

  const { symbol, mid } = raw.payload;

  return typeof symbol === "string" && typeof mid === "number"
    ? { type: SERVER_MSG.PRICE, payload: { symbol, mid } }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
