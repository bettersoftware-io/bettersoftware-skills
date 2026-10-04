import { describePricePortContract } from "@fx/domain/ports/__contracts__/PricePortContract.ts";

import { createWsPrice } from "./wsPrice.ts";

describePricePortContract("ws", createWsPrice);
