import { createWsPrice } from "@fx/client-core";
import type { PricePort } from "@fx/domain";

import { describeAgreement } from "./__testUtils__/describeAgreement.ts";

describeAgreement("prices", (): PricePort => createWsPrice());
