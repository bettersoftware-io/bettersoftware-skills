import type { Price } from "@app/domain";

/**
 * One picture: a name and the state the screen is in when it is taken. The
 * state is data, never a click. The visual host turns it into deliveries on
 * the app harness, so the real presenters decide what the rows look like.
 */
export interface Scenario {
  /**
   * Prices that arrived long enough ago for their rows to have gone stale.
   * Delivered first, in order; then the stale wait passes on the host's clock.
   */
  stalePrices?: readonly Price[];
  /**
   * Prices that have just arrived, in order. A second price for a symbol shows
   * as a movement against the first.
   */
  prices: readonly Price[];
  /** The symbol of the row that is selected. */
  selected?: string;
}

/** Two symbols that have each moved once: EURUSD up, GBPUSD down. */
const MOVES: readonly Price[] = [
  { symbol: "EURUSD", mid: 1.1 },
  { symbol: "GBPUSD", mid: 1.25 },
  { symbol: "EURUSD", mid: 1.1012 },
  { symbol: "GBPUSD", mid: 1.2488 },
];

const USDJPY: Price = { symbol: "USDJPY", mid: 151.2 };

/**
 * Every scenario, keyed by name. The name is the golden's file name
 * (`goldens/<platform>/<name>.png`) and the test's title, so keep it short,
 * lower-case and dashed. Each scenario needs a golden on every platform that
 * runs the tier; `pnpm visual` says which are missing.
 */
export const scenarios: Record<string, Scenario> = {
  empty: {
    prices: [],
  },
  "rows-up-and-down": {
    prices: [...MOVES, USDJPY],
  },
  "row-selected": {
    prices: [...MOVES, USDJPY],
    selected: "GBPUSD",
  },
  "row-stale": {
    stalePrices: [USDJPY],
    prices: MOVES,
  },
};
