import { describePricePortContract } from "../ports/__contracts__/PricePortContract.ts";
import { createPriceSimulator } from "./priceSimulator.ts";

describePricePortContract("simulator", createPriceSimulator);
