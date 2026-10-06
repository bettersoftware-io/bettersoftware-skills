import type { ReactElement } from "react";

interface SharedProps {
  rows: number[];
  limit: number;
}

// `visible` is read only by `count`, so the compiler puts both in one cache
// block: `visible` is declared bare and read back from its slot.
export function Shared({ rows, limit }: SharedProps): ReactElement {
  const visible = rows.filter((row) => {
    return row < limit;
  });
  const count = visible.length;

  return (
    <p>
      {count} of {visible.join(", ")}
    </p>
  );
}
