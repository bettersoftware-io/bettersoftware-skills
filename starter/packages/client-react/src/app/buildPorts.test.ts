import type { Price } from "@app/domain";
import { installFakeWebSocket } from "@app/client-core/testing/fakeWebSocket.ts";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { buildPorts } from "./buildPorts.ts";

describe("choosing what stands behind the ports", () => {
  it("runs on the simulator when there is no server URL", () => {
    const said = silenceInfo();
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const received: Price[] = [];

    const subscription = buildPorts(undefined)
      .price.prices()
      .subscribe((price) => received.push(price));
    vi.advanceTimersByTime(500);
    subscription.unsubscribe();

    expect(received).toHaveLength(1);
    expect(said).toHaveBeenCalledWith("[data] composed sim: no VITE_SERVER_URL");
  });

  it("connects to the server when there is one", () => {
    const said = silenceInfo();
    const network = installFakeWebSocket();
    onTestFinished(network.restore);

    const subscription = buildPorts("ws://example.test/ws").price.prices().subscribe();
    subscription.unsubscribe();

    expect(network.sockets.map((socket) => socket.url)).toEqual(["ws://example.test/ws"]);
    expect(said).toHaveBeenCalledWith("[data] composed live from ws://example.test/ws");
  });
});

/** The composition says which source it chose; a test reads that instead of printing it. */
function silenceInfo(): ReturnType<typeof vi.spyOn> {
  const said = vi.spyOn(console, "info").mockImplementation(() => {});

  onTestFinished(() => {
    said.mockRestore();
  });

  return said;
}
