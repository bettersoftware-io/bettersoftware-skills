import type { ReactElement } from "react";

interface TotalsProps {
  rows: number[];
  onPick: (row: number) => void;
}

// What a component gives up `useMemo` and `useCallback` for: `total` is
// derived from a prop, and `pickFirst` is a callback handed to a child.
export function Totals({ rows, onPick }: TotalsProps): ReactElement {
  const total = rows.reduce((sum, row) => {
    return sum + row;
  }, 0);

  function pickFirst(): void {
    onPick(rows[0] ?? 0);
  }

  return <button onClick={pickFirst}>{total}</button>;
}
