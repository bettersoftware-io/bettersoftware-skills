import type { ReactElement } from "react";

import { PriceList } from "./PriceList.tsx";

export function App(): ReactElement {
  return (
    <main>
      <h1>Prices</h1>
      <PriceList />
    </main>
  );
}
