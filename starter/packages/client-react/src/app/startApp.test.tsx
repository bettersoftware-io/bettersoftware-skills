import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearPage, startAppOnPage } from "./startApp.page.tsx";
import { startApp } from "./startApp.tsx";

describe("starting the app", () => {
  beforeEach(() => {
    // With no server URL the app runs on the simulator, which ticks on a timer.
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    clearPage();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("draws the UI into #root, fed by the simulator", async () => {
    const page = await startAppOnPage();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(page.heading()).toBe("Prices");
    expect(page.rowCount()).toBe(1);

    await page.stop();
  });

  it("leaves nothing drawn and no timer running once it is stopped", async () => {
    const page = await startAppOnPage();

    await page.stop();
    await vi.runOnlyPendingTimersAsync();

    expect(page.isBlank()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses to start on a page with no #root", () => {
    expect(() => startApp()).toThrow("index.html has no #root element");
  });
});
