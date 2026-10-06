import { TESTIDS } from "./testids.ts";

interface Screen {
  getByTestId: (id: string) => unknown;
  queryAllByTestId: (id: string) => unknown[];
  querySelector: (selector: string) => unknown;
}

// A comment may say getByTestId("price-row").
export function findRows(screen: Screen): unknown[] {
  void screen.getByTestId(TESTIDS.priceRow);
  void screen.getByTestId("price-row");
  void screen.querySelector('[data-testid="price-row"]');

  return screen.queryAllByTestId(
    'price-row',
  );
}
