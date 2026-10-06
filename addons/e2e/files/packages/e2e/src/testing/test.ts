import { test as base, expect, type Page } from "@playwright/test";

import {
  createPriceListPage,
  type PriceListPage,
} from "../pages/PriceList.page.ts";
import {
  type ServerFeedPage,
  watchServerFeed,
} from "../pages/ServerFeed.page.ts";

/** What the Playwright config sets for each mode. */
export interface ModeOptions {
  /** The address of the mode's server. Empty in a mode that has none. */
  serverUrl: string;
}

interface PageObjects {
  priceList: PriceListPage;
  serverFeed: ServerFeedPage;
  /** Fails a test whose page threw. Every test has it, asked for or not. */
  crashes: string[];
}

/**
 * The `test` every spec imports. It hands out page objects, and that is how a
 * spec reaches the browser: a new page object is added here.
 */
export const test = base.extend<PageObjects & ModeOptions>({
  serverUrl: ["", { option: true }],

  priceList: async (
    { page }: WithPage,
    use: Use<PriceListPage>,
  ): Promise<void> => {
    await use(createPriceListPage(page));
  },

  serverFeed: async (
    { page, serverUrl }: WithPage & ModeOptions,
    use: Use<ServerFeedPage>,
  ): Promise<void> => {
    await use(watchServerFeed(page, serverUrl));
  },

  crashes: [
    async ({ page }: WithPage, use: Use<string[]>): Promise<void> => {
      const crashes: string[] = [];

      page.on("pageerror", (error) => {
        crashes.push(error.message);
      });

      await use(crashes);

      expect(crashes, "the page threw an error nothing caught").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

interface WithPage {
  page: Page;
}

/** Hands a fixture to the test, and resolves when the test is over. */
type Use<T> = (value: T) => Promise<void>;
