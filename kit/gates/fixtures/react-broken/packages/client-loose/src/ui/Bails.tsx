import { type ReactElement, useRef } from "react";

interface BailsProps {
  count: number;
}

// Reads and writes a ref while rendering, so the compiler skips the whole
// component: `doubled` is built on every render and nothing says so.
export function Bails({ count }: BailsProps): ReactElement {
  const renders = useRef(0);

  renders.current += 1;

  const doubled = [count, count];

  return (
    <p>
      {doubled.length} {renders.current}
    </p>
  );
}
