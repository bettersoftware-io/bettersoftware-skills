import type { ReactElement } from "react";

interface InlineProps {
  count: number;
}

// The component compiles. `label` is plain arithmetic, which the compiler
// does not cache: it is worked out on every render.
export function Inline({ count }: InlineProps): ReactElement {
  const label = count * 2;

  return <p>{label}</p>;
}
