import { describe, expect, it, onTestFinished, vi } from "vitest";

import { mountUnderProvider, mountWithoutProvider } from "./viewModel.page.tsx";

describe("the view model", () => {
  it("gives a component under the provider the application's prices as they arrive", async () => {
    const page = mountUnderProvider();

    expect(page.symbols()).toEqual([]);

    await page.deliverPrice({ symbol: "EURUSD", mid: 1.1 });

    expect(page.symbols()).toEqual(["EURUSD"]);
  });

  it("gives a component a selection it can read and change", async () => {
    const page = mountUnderProvider();

    expect(page.selected()).toBeNull();

    await page.select("EURUSD");

    expect(page.selected()).toBe("EURUSD");
  });

  it("tells a component with no provider above it what is missing", () => {
    // React prints the error it catches; the message is asserted below instead.
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => {
      printed.mockRestore();
    });

    expect(() => {
      mountWithoutProvider();
    }).toThrow("useViewModel needs a <ViewModelProvider> above it in the tree");
  });
});
