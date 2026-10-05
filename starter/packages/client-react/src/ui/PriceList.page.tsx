import { act, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { createAppHarness } from "@app/client-core/testing/appHarness.ts";
import type { Movement, Price } from "@app/domain";
import { createViewModel, ViewModelProvider } from "@app/react-bindings";

import { PriceList } from "./PriceList.tsx";
import { TESTIDS } from "./testids.ts";

/** What a test can do with, and ask of, the price list. */
export interface PriceListPage {
  showPrice: (price: Price) => void;
  symbols: () => string[];
  movementOf: (symbol: string) => Movement;
  selectedSymbol: () => string | null;
  clickRow: (symbol: string) => Promise<void>;
}

/**
 * Mounts the price list on the real application, with only the outside world
 * replaced. The test says what happens; how the screen is driven stays here.
 */
export function mountPriceList(): PriceListPage {
  const harness = createAppHarness();
  const user = userEvent.setup();

  const rendered = render(
    <ViewModelProvider viewModel={createViewModel(harness.app)}>
      <PriceList />
    </ViewModelProvider>,
  );

  function findRows(): HTMLElement[] {
    return within(rendered.getByTestId(TESTIDS.priceList)).queryAllByTestId(TESTIDS.priceRow);
  }

  function findRow(symbol: string): HTMLElement {
    const row = findRows().find(
      (candidate) => within(candidate).queryByRole("rowheader")?.textContent === symbol,
    );

    if (row === undefined) {
      throw new Error(`no row for ${symbol}`);
    }

    return row;
  }

  return {
    showPrice: (price: Price): void => {
      act(() => {
        harness.deliverPrice(price);
      });
    },
    symbols: (): string[] =>
      findRows().map((row) => within(row).getByRole("rowheader").textContent ?? ""),
    movementOf: (symbol: string): Movement =>
      within(findRow(symbol)).getByRole("cell").dataset.movement as Movement,
    selectedSymbol: (): string | null => {
      const selected = findRows().find((row) => row.dataset.selected === "true");

      return selected ? (within(selected).getByRole("rowheader").textContent ?? null) : null;
    },
    clickRow: async (symbol: string): Promise<void> => {
      await user.click(findRow(symbol));
    },
  };
}
