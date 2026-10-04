import { createPriceSimulator } from "@app/domain";
import { WS_PATH } from "@app/shared";

import { startServer } from "./startServer.ts";

// The server's composition root: read the configuration, pick the price
// source, start.
const server = await startServer({
  port: Number(process.env.PORT ?? 4000),
  prices: createPriceSimulator(),
});

console.info(`price server listening on ws://localhost:${server.port}${WS_PATH}`);
