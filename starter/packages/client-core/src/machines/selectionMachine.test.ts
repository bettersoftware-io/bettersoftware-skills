import { describe, expect, it } from "vitest";

import { createSelectionMachine, reduceSelection } from "./selectionMachine.ts";

describe("reduceSelection", () => {
  it("selects a symbol", () => {
    expect(reduceSelection({ selected: null }, { type: "select", symbol: "EURUSD" })).toEqual({ selected: "EURUSD" });
  });

  it("moves the selection to another symbol", () => {
    expect(reduceSelection({ selected: "EURUSD" }, { type: "select", symbol: "GBPUSD" })).toEqual({
      selected: "GBPUSD",
    });
  });

  it("clears when the selected symbol is selected again", () => {
    expect(reduceSelection({ selected: "EURUSD" }, { type: "select", symbol: "EURUSD" })).toEqual({ selected: null });
  });

  it("clears on request", () => {
    expect(reduceSelection({ selected: "EURUSD" }, { type: "clear" })).toEqual({ selected: null });
  });
});

describe("the selection machine", () => {
  it("starts with nothing selected", () => {
    const machine = createSelectionMachine();

    expect(machine.state$.getValue()).toEqual({ selected: null });

    machine.dispose();
  });

  it("keeps an intent sent before anyone subscribes", () => {
    const machine = createSelectionMachine();

    machine.intents.select("EURUSD");

    expect(machine.state$.getValue()).toEqual({ selected: "EURUSD" });

    machine.dispose();
  });

  it("clears the selection on request", () => {
    const machine = createSelectionMachine();

    machine.intents.select("EURUSD");
    machine.intents.clear();

    expect(machine.state$.getValue()).toEqual({ selected: null });

    machine.dispose();
  });

  it("ignores intents after it is disposed", () => {
    const machine = createSelectionMachine();
    const seen: (string | null)[] = [];

    machine.state$.subscribe((current) => seen.push(current.selected));
    machine.intents.select("EURUSD");
    machine.dispose();
    machine.intents.select("GBPUSD");

    expect(seen).toEqual([null, "EURUSD"]);
  });
});
