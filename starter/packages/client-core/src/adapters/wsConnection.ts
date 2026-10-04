import { defer, type Observable, retry } from "rxjs";
import { webSocket } from "rxjs/webSocket";

/** A stream of parsed messages from a server. Subscribing connects; leaving closes. */
export interface WsConnection {
  messages(): Observable<unknown>;
}

const RECONNECT_DELAY_MS = 1000;

/** Connects on subscribe and reconnects after a drop, for as long as someone listens. */
export function createWsConnection(url: string): WsConnection {
  return {
    messages: (): Observable<unknown> =>
      defer(() => webSocket<unknown>(url)).pipe(retry({ delay: RECONNECT_DELAY_MS })),
  };
}
