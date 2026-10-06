// The code under test, imported into the test of it.
import { createWsPrice } from "@fx/client-core";
import { TESTIDS } from "@fx/client-react/ui/testids.ts";
import type { PricePort } from "@fx/domain";

import { rowSelector } from "../helpers.ts";

export const port: PricePort = createWsPrice();
export const found = [TESTIDS, rowSelector()];
