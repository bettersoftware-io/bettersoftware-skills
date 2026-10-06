import { TESTIDS } from "./testids.ts";

// A comment may say data-testid="price-row".
export function PriceRow(): unknown {
  return (
    <tr data-testid="price-row">
      <td data-testid={TESTIDS.priceRow} />
      <td data-testid={`price-${1}`} />
    </tr>
  );
}
