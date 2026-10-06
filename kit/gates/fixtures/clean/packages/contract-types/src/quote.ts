export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
}

export type Side = "bid" | "ask";
