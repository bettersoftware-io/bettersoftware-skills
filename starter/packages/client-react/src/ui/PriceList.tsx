import type { PriceRow } from "@app/client-core";
import { useViewModel } from "@app/react-bindings";
import type { ReactElement } from "react";

import { TESTIDS } from "./testids.ts";

/**
 * A dumb component: it renders the rows the view model gives it and reports a
 * click. Order, movement and staleness are already decided by the core.
 */
export function PriceList(): ReactElement {
  const viewModel = useViewModel();
  const rows = viewModel.usePrices();
  const selection = viewModel.useSelection();

  return (
    <table data-testid={TESTIDS.priceList}>
      <thead>
        <tr>
          <th scope="col">Symbol</th>
          <th scope="col">Mid</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <PriceRowView
            key={row.symbol}
            row={row}
            selected={selection.state.selected === row.symbol}
            onSelect={selection.select}
          />
        ))}
      </tbody>
    </table>
  );
}

interface PriceRowViewProps {
  row: PriceRow;
  selected: boolean;
  onSelect: (symbol: string) => void;
}

function PriceRowView({ row, selected, onSelect }: PriceRowViewProps): ReactElement {
  function selectRow(): void {
    onSelect(row.symbol);
  }

  return (
    <tr data-testid={TESTIDS.priceRow} data-selected={selected} data-stale={row.stale} onClick={selectRow}>
      <th scope="row">{row.symbol}</th>
      <td data-movement={row.movement}>{row.mid.toFixed(4)}</td>
    </tr>
  );
}
