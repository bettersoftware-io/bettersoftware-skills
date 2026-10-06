import { readFileSync } from "node:fs";

import { createWsPrice } from "../adapters/wsPrice.ts";
import { createAppHarness } from "../testing/appHarness.ts";
import { createPricesPresenter } from "./pricesPresenter.ts";

// A test may run a presenter over a real adapter, read a file, and ask the
// harness for the application. It never calls createApp(ports) itself.
void createPricesPresenter(createWsPrice());
void createAppHarness();
void readFileSync;
