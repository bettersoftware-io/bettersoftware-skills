/** The latest mid price of one instrument. */
export interface Price {
  symbol: string;
  mid: number;
}

export type Movement = "up" | "down" | "flat";

/** A price together with how it moved against the previous one for its symbol. */
export interface PriceTick extends Price {
  movement: Movement;
}
