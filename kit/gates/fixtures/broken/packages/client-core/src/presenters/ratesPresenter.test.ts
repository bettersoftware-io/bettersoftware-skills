import { readFileSync } from "node:fs";

import { createWsPrice } from "../adapters/wsPrice.ts";
import { createApp } from "../composition.ts";
import { createAppHarness } from "../testing/appHarness.ts";
import { FAKE_PRICES } from "../testing/fakePrices.ts";

// A comment may say createApp(ports).
void createAppHarness();
void createApp({ price: createWsPrice() });
void [FAKE_PRICES, readFileSync];
