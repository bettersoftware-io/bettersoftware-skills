import { type ReactElement, useMemo } from "react";

// No compiler in this client's build, so a hand-written memo is allowed.
export function App(): ReactElement {
  const label = useMemo(() => {
    return "plain";
  }, []);

  return <main>{label}</main>;
}
