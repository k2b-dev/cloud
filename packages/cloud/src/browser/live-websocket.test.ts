import { afterEach, describe, expect, test } from "bun:test";
import { createLiveWebSocket } from "./live-websocket";

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";

  setVisibility(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closes: Array<{ code: number; reason: string }> = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  close(code = 1000, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.closes.push({ code, reason });
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalWebSocket = globalThis.WebSocket;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

let document: FakeDocument;
let timers: Array<(() => void) | null>;
let timerDelays: number[];

const installBrowser = () => {
  FakeWebSocket.instances = [];
  timers = [];
  timerDelays = [];
  document = new FakeDocument();
  (globalThis as unknown as { window: unknown }).window = { location: { origin: "http://localhost:3000" } };
  (globalThis as unknown as { document: unknown }).document = document;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  globalThis.setTimeout = ((callback: () => void, delay = 0) => {
    timers.push(callback);
    timerDelays.push(delay);
    return timers.length;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    timers[id - 1] = null;
  }) as typeof clearTimeout;
};

const runNextTimer = () => {
  const index = timers.findIndex(Boolean);
  if (index < 0) throw new Error("No pending timer");
  const timer = timers[index];
  timers[index] = null;
  timer?.();
};

const subscribeCursor = (socket: FakeWebSocket): unknown => {
  const message = JSON.parse(socket.sent.at(-1) ?? "{}") as { payload?: { fromCursor?: unknown } };
  return message.payload?.fromCursor;
};

afterEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as unknown as { window: unknown }).window = originalWindow;
  (globalThis as unknown as { document: unknown }).document = originalDocument;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

describe("createLiveWebSocket", () => {
  test("can be disposed before browser setup", () => {
    const connection = createLiveWebSocket({
      url: "/api/example/ws",
      subscribe: () => ({ type: "subscribe" }),
      parse: () => null,
      onMessage: () => undefined,
    });

    expect(() => connection.dispose()).not.toThrow();
  });

  test("subscribes once and resumes from the last applied cursor", () => {
    installBrowser();
    const statuses: string[] = [];
    const connection = createLiveWebSocket<{ cursor: string }>({
      url: "/api/example/ws",
      initialCursor: "4-1",
      subscribe: (cursor) => ({ type: "subscribe", payload: { fromCursor: cursor } }),
      parse: (raw) => JSON.parse(raw) as { cursor: string },
      onMessage: (message, controls) => controls.markApplied(message.cursor),
      onStatus: (status) => statuses.push(status),
    });

    connection.connect();
    connection.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.url).toBe("ws://localhost:3000/api/example/ws");
    FakeWebSocket.instances[0]!.open();
    expect(subscribeCursor(FakeWebSocket.instances[0]!)).toBe("4-1");

    FakeWebSocket.instances[0]!.message({ cursor: "4-2" });
    FakeWebSocket.instances[0]!.close(1006);
    runNextTimer();
    FakeWebSocket.instances[1]!.open();
    expect(subscribeCursor(FakeWebSocket.instances[1]!)).toBe("4-2");
    expect(statuses).toEqual(["connecting", "open", "reconnecting", "open"]);

    connection.dispose();
    expect(statuses.at(-1)).toBe("closed");
  });

  test("opens additional typed channels through the same socket", () => {
    installBrowser();
    const connection = createLiveWebSocket({
      url: "/api/example/ws",
      subscribe: () => ({ type: "live.subscribe" }),
      parse: () => null,
      onOpen: (controls) => {
        expect(controls.send({ type: "turn.subscribe", payload: { id: "Chat01" } })).toBe(true);
      },
      onMessage: () => undefined,
    });

    connection.connect();
    FakeWebSocket.instances[0]!.open();
    expect(FakeWebSocket.instances[0]!.sent.map((item) => JSON.parse(item))).toEqual([
      { type: "live.subscribe" },
      { type: "turn.subscribe", payload: { id: "Chat01" } },
    ]);
    expect(connection.send({ type: "turn.unsubscribe", payload: { id: "Chat01" } })).toBe(true);
    expect(FakeWebSocket.instances[0]!.sent.map((item) => JSON.parse(item)).at(-1)).toEqual({
      type: "turn.unsubscribe",
      payload: { id: "Chat01" },
    });
    connection.dispose();
  });

  test("does not advance a cursor until the app marks it applied", () => {
    installBrowser();
    const connection = createLiveWebSocket<{ cursor: string }>({
      url: "/api/example/ws",
      subscribe: (cursor) => ({ payload: { fromCursor: cursor } }),
      parse: (raw) => JSON.parse(raw) as { cursor: string },
      onMessage: () => undefined,
    });

    connection.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.message({ cursor: "9-1" });
    FakeWebSocket.instances[0]!.close(1006);
    runNextTimer();
    FakeWebSocket.instances[1]!.open();

    expect(subscribeCursor(FakeWebSocket.instances[1]!)).toBeNull();
    connection.dispose();
  });

  test("only resets reconnect backoff after a valid message", () => {
    installBrowser();
    const connection = createLiveWebSocket<{ type: "ready" }>({
      url: "/api/example/ws",
      subscribe: () => ({ type: "subscribe" }),
      parse: (raw) => JSON.parse(raw) as { type: "ready" },
      onMessage: () => undefined,
      reconnect: { baseDelayMs: 10, maxDelayMs: 100, jitterMs: 0 },
    });

    connection.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.close(1012);
    expect(timerDelays.at(-1)).toBe(10);

    runNextTimer();
    FakeWebSocket.instances[1]!.open();
    FakeWebSocket.instances[1]!.close(1012);
    expect(timerDelays.at(-1)).toBe(20);

    runNextTimer();
    FakeWebSocket.instances[2]!.open();
    FakeWebSocket.instances[2]!.message({ type: "ready" });
    FakeWebSocket.instances[2]!.close(1012);
    expect(timerDelays.at(-1)).toBe(10);
    connection.dispose();
  });

  test("pauses hidden tabs and reconnects when they become visible", () => {
    installBrowser();
    const statuses: string[] = [];
    const connection = createLiveWebSocket({
      url: "/api/example/ws",
      subscribe: (cursor) => ({ payload: { fromCursor: cursor } }),
      parse: () => null,
      onMessage: () => undefined,
      onStatus: (status) => statuses.push(status),
    });

    connection.connect();
    FakeWebSocket.instances[0]!.open();
    document.setVisibility("hidden");
    expect(FakeWebSocket.instances[0]!.closes).toEqual([{ code: 1000, reason: "inactive" }]);
    expect(timers.filter(Boolean)).toHaveLength(0);

    document.setVisibility("visible");
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(statuses).toEqual(["connecting", "open", "paused", "connecting"]);
    connection.dispose();
  });

  test("reports terminal closes once and never reconnects", () => {
    installBrowser();
    const errors: string[] = [];
    const connection = createLiveWebSocket({
      url: "/api/example/ws",
      subscribe: () => ({ type: "subscribe" }),
      parse: () => null,
      onMessage: () => undefined,
      onFatal: (error) => errors.push(error.code),
    });

    connection.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.close(1008, "access_denied");
    document.setVisibility("hidden");
    document.setVisibility("visible");

    expect(errors).toEqual(["access_denied"]);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(timers.filter(Boolean)).toHaveLength(0);
    connection.dispose();
  });
});
