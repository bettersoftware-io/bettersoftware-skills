/** One connection the code under test opened, driven by hand. */
interface FakeSocket {
  url: string;
  /** True once the code under test has closed it. */
  closed: boolean;
  open: () => void;
  /** The server sends this message. */
  receive: (message: unknown) => void;
  /** The connection is lost without a clean close. */
  drop: () => void;
}

export interface FakeWebSocket {
  /** Every connection opened since the fake was installed, oldest first. */
  sockets: FakeSocket[];
  /** Puts the real `WebSocket` back. */
  restore: () => void;
}

interface SocketHandlers {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: ReceivedMessage) => void) | null;
  onclose: ((event: Closing) => void) | null;
}

interface ReceivedMessage {
  data: string;
}

interface Closing {
  wasClean: boolean;
}

/** What `new WebSocket(url)` hands back: the handlers the adapter sets, and the two members it reads. */
interface OpenedSocket extends SocketHandlers {
  readyState: number;
  close: () => void;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/**
 * Replaces the global `WebSocket` with one a test drives by hand, so an
 * adapter is tested without a server or a network. Call `restore` when the
 * test ends.
 */
export function installFakeWebSocket(): FakeWebSocket {
  const real = globalThis.WebSocket;
  const sockets: FakeSocket[] = [];

  function connect(url: string): SocketHandlers {
    const handlers: OpenedSocket = {
      readyState: CONNECTING,
      onopen: null,
      onmessage: null,
      onclose: null,
      close: (): void => {
        handlers.readyState = CLOSED;
        socket.closed = true;
      },
    };

    const socket: FakeSocket = {
      url,
      closed: false,
      open: (): void => {
        handlers.readyState = OPEN;
        handlers.onopen?.({});
      },
      receive: (message: unknown): void => {
        handlers.onmessage?.({ data: JSON.stringify(message) });
      },
      drop: (): void => {
        handlers.readyState = CLOSED;
        handlers.onclose?.({ wasClean: false });
      },
    };

    sockets.push(socket);

    return handlers;
  }

  // `new WebSocket(url)` returns whatever the constructor returns when that
  // is an object, so a plain function stands in for the class.
  globalThis.WebSocket = function WebSocket(url: string): SocketHandlers {
    return connect(url);
  } as unknown as typeof globalThis.WebSocket;

  return {
    sockets,
    restore: (): void => {
      globalThis.WebSocket = real;
    },
  };
}
