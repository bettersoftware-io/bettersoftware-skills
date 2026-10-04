import { act } from "react";

import { startApp } from "./startApp.tsx";

export interface StartedApp {
  heading: () => string | null;
  rowCount: () => number;
  /** True when nothing is drawn in #root. */
  isBlank: () => boolean;
  stop: () => Promise<void>;
}

/** Gives the page a #root, as index.html does, and starts the app in it. */
export async function startAppOnPage(): Promise<StartedApp> {
  document.body.innerHTML = '<div id="root"></div>';

  let stop = (): void => {};

  await act(async () => {
    stop = startApp();
  });

  return {
    heading: (): string | null => document.querySelector("h1")?.textContent ?? null,
    rowCount: (): number => document.querySelectorAll("tbody tr").length,
    isBlank: (): boolean => document.getElementById("root")?.childElementCount === 0,
    stop: async (): Promise<void> => {
      await act(async () => {
        stop();
      });
    },
  };
}

/** Leaves the page as a test found it. */
export function clearPage(): void {
  document.body.replaceChildren();
}
