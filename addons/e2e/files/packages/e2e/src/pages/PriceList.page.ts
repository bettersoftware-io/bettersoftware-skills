import type { Locator, Page } from "@playwright/test";

import { TESTIDS } from "@app/client-react/src/ui/testids.ts";

/** One row of the price list, as a user reads it. */
interface ShownRow {
  symbol: string;
  /** The mid as text: what is on the screen, not a number worked out from it. */
  mid: string;
  selected: boolean;
}

/** What a spec can do with, and ask of, the price list. */
export interface PriceListPage {
  open: () => Promise<void>;
  /** Every row, read in one step, so the list cannot change between two rows. */
  rows: () => Promise<ShownRow[]>;
  /** The mid shown for a symbol, or null while it has no row. */
  midOf: (symbol: string) => Promise<string | null>;
  selectedSymbol: () => Promise<string | null>;
  clickRow: (symbol: string) => Promise<void>;
}

export function createPriceListPage(page: Page): PriceListPage {
  const list = page.getByTestId(TESTIDS.priceList);
  const everyRow = list.getByTestId(TESTIDS.priceRow);

  function rowOf(symbol: string): Locator {
    return everyRow.filter({
      has: page.getByRole("rowheader", { name: symbol, exact: true }),
    });
  }

  async function readRows(): Promise<ShownRow[]> {
    return everyRow.evaluateAll((elements) => {
      return elements.map((element) => {
        return {
          symbol: element.querySelector("th")?.textContent ?? "",
          mid: element.querySelector("td")?.textContent ?? "",
          selected: element.getAttribute("data-selected") === "true",
        };
      });
    });
  }

  return {
    open: async (): Promise<void> => {
      await page.goto("/");
      await list.waitFor();
    },
    rows: readRows,
    midOf: async (symbol: string): Promise<string | null> => {
      const rows = await readRows();

      return (
        rows.find((row) => {
          return row.symbol === symbol;
        })?.mid ?? null
      );
    },
    selectedSymbol: async (): Promise<string | null> => {
      const rows = await readRows();

      return (
        rows.find((row) => {
          return row.selected;
        })?.symbol ?? null
      );
    },
    clickRow: async (symbol: string): Promise<void> => {
      await rowOf(symbol).click();
    },
  };
}
