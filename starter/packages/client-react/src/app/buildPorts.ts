import {
  type AppPorts,
  createWsConnection,
  createWsPricePort,
} from "@app/client-core";
import { createPriceSimulator } from "@app/domain";

/**
 * Picks what stands behind each port. This is the only place that chooses an
 * adapter: with a server URL the app talks to the server, without one it runs
 * on the simulator.
 */
export function buildPorts(serverUrl: string | undefined): AppPorts {
  if (serverUrl) {
    console.info(`[data] composed live from ${serverUrl}`);

    return { price: createWsPricePort(createWsConnection(serverUrl)) };
  }

  console.info("[data] composed sim: no VITE_SERVER_URL");

  return { price: createPriceSimulator() };
}
