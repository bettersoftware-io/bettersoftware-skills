import { type AppHarness, createAppHarness } from "@app/client-core/testing/appHarness.ts";
import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";

import { createViewModel } from "./createViewModel.ts";
import { useViewModel } from "./useViewModel.ts";
import { ViewModelProvider } from "./ViewModelProvider.tsx";

/** A price, as the harness takes it. This package does not depend on the domain itself. */
type Price = Parameters<AppHarness["deliverPrice"]>[0];

export interface ViewModelPage {
  /** The symbols of the rows the component sees, in order. */
  symbols: () => string[];
  /** The symbol the component sees as selected. */
  selected: () => string | null;
  deliverPrice: (price: Price) => Promise<void>;
  select: (symbol: string) => Promise<void>;
}

/** Mounts a component that reads everything the view model offers, under a provider, on the real application. */
export function mountUnderProvider(): ViewModelPage {
  const harness = createAppHarness();
  const seen: Seen = { symbols: [], selected: null, select: () => {} };

  render(
    <ViewModelProvider viewModel={createViewModel(harness.app)}>
      <Reader seen={seen} />
    </ViewModelProvider>,
  );

  return {
    symbols: (): string[] => seen.symbols,
    selected: (): string | null => seen.selected,
    deliverPrice: async (price: Price): Promise<void> => {
      await act(async () => {
        harness.deliverPrice(price);
      });
    },
    select: async (symbol: string): Promise<void> => {
      await act(async () => {
        seen.select(symbol);
      });
    },
  };
}

/** Mounts the same component with no provider above it. React reports what the component threw. */
export function mountWithoutProvider(): void {
  render(<Reader seen={{ symbols: [], selected: null, select: () => {} }} />);
}

interface Seen {
  symbols: string[];
  selected: string | null;
  select: (symbol: string) => void;
}

function Reader({ seen }: { seen: Seen }): ReactElement {
  const viewModel = useViewModel();
  const selection = viewModel.useSelection();

  seen.symbols = viewModel.usePrices().map((row) => row.symbol);
  seen.selected = selection.state.selected;
  seen.select = selection.select;

  return <output />;
}
