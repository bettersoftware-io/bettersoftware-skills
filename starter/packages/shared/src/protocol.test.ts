import { describe, expect, it } from "vitest";

import { decodePrice, encodePrice, parseServerMessage } from "./protocol.ts";

describe("the wire protocol", () => {
  it("carries a price to the wire and back unchanged", () => {
    const message = parseServerMessage(JSON.parse(JSON.stringify(encodePrice({ symbol: "EURUSD", mid: 1.1 }))));

    expect(message && decodePrice(message.payload)).toEqual({ symbol: "EURUSD", mid: 1.1 });
  });

  it("rejects anything that is not a known message", () => {
    expect(parseServerMessage(null)).toBeUndefined();
    expect(parseServerMessage("price")).toBeUndefined();
    expect(parseServerMessage({ type: "unknown", payload: {} })).toBeUndefined();
    expect(parseServerMessage({ type: "price" })).toBeUndefined();
    expect(parseServerMessage({ type: "price", payload: { symbol: "EURUSD", mid: "1.1" } })).toBeUndefined();
  });
});
