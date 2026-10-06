import type { PricePort } from "@fx/domain";

export interface AppPorts {
  price: PricePort;
}

export function createApp(ports: AppPorts): AppPorts {
  return ports;
}
