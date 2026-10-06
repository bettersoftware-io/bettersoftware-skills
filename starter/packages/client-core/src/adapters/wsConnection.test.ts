import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type FakeWebSocket,
  installFakeWebSocket,
} from "../testing/fakeWebSocket.ts";
import { createWsConnection } from "./wsConnection.ts";

describe("the WebSocket connection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    network = installFakeWebSocket();
  });

  afterEach(() => {
    network.restore();
    vi.useRealTimers();
  });

  it("connects when someone subscribes, and not before", () => {
    const connection = createWsConnection(SERVER_URL);

    expect(network.sockets).toHaveLength(0);

    connection.messages().subscribe();

    expect(
      network.sockets.map((socket) => {
        return socket.url;
      }),
    ).toEqual([SERVER_URL]);
  });

  it("delivers each message the server sends, parsed", () => {
    const received: unknown[] = [];

    createWsConnection(SERVER_URL)
      .messages()
      .subscribe((message) => {
        return received.push(message);
      });
    network.sockets[0]?.open();
    network.sockets[0]?.receive({ type: "price", payload: 1 });
    network.sockets[0]?.receive({ type: "price", payload: 2 });

    expect(received).toEqual([
      { type: "price", payload: 1 },
      { type: "price", payload: 2 },
    ]);
  });

  it("closes the connection when its subscriber leaves", () => {
    const subscription = createWsConnection(SERVER_URL).messages().subscribe();

    network.sockets[0]?.open();
    subscription.unsubscribe();

    expect(network.sockets[0]?.closed).toBe(true);
  });

  it("connects again one second after the connection drops, and carries on delivering", () => {
    const received: unknown[] = [];

    createWsConnection(SERVER_URL)
      .messages()
      .subscribe((message) => {
        return received.push(message);
      });
    network.sockets[0]?.open();
    network.sockets[0]?.drop();

    vi.advanceTimersByTime(999);
    expect(network.sockets).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(network.sockets).toHaveLength(2);

    network.sockets[1]?.open();
    network.sockets[1]?.receive({ type: "price", payload: 3 });

    expect(received).toEqual([{ type: "price", payload: 3 }]);
  });

  let network: FakeWebSocket;
});

const SERVER_URL = "ws://example.test/ws";
