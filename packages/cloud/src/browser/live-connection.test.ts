import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { liveConnection } from "./live-connection";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: Record<string, unknown>[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
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
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

const originals = {
  window: globalThis.window,
  document: globalThis.document,
  WebSocket: globalThis.WebSocket,
  setTimeout: globalThis.setTimeout,
};
let timers: { run: () => void; delay: number }[];

beforeEach(() => {
  FakeWebSocket.instances = [];
  timers = [];
  (globalThis as unknown as { window: unknown }).window = Object.assign(new EventTarget(), {
    location: { origin: "http://localhost:3000" },
  });
  (globalThis as unknown as { document: unknown }).document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  globalThis.setTimeout = ((run: () => void, delay = 0) => timers.push({ run, delay })) as unknown as typeof setTimeout;
});

afterEach(() => {
  (globalThis as unknown as { window: unknown }).window = originals.window;
  (globalThis as unknown as { document: unknown }).document = originals.document;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = originals.WebSocket;
  globalThis.setTimeout = originals.setTimeout;
});

/** Runs the pending timers with this delay, as if it elapsed. */
const elapse = async (delay: number) => {
  await Bun.sleep(1);
  for (const timer of timers.filter((candidate) => candidate.delay === delay)) {
    timers.splice(timers.indexOf(timer), 1);
    timer.run();
  }
  await Bun.sleep(1);
};

const recorder = () => {
  const log: string[] = [];
  let failing = 0;
  return {
    log,
    failNext: (times: number) => {
      failing = times;
    },
    handlers: (cursor: string | null = "s6t.app.1") => ({
      cursor,
      parse: (data: unknown) => {
        if (typeof data !== "number") throw new Error("invalid");
        return data;
      },
      apply: async (events: { data: number; cursor: string }[]) => {
        log.push(`apply:${events.map((event) => event.data).join(",")}`);
        if (failing-- > 0) throw new Error("apply failed");
      },
      resync: async () => {
        log.push("resync");
      },
      revoked: (code: string) => log.push(`revoked:${code}`),
      unavailable: () => log.push("unavailable"),
    }),
  };
};

describe("liveConnection", () => {
  test("shares one socket per URL and resubscribes each subscription from its applied cursor", async () => {
    const first = recorder();
    const second = recorder();
    const a = liveConnection("/api/app/live").subscribe("item", { key: "a" }, first.handlers());
    const b = liveConnection("/api/app/live").subscribe("list", {}, second.handlers(null));
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    socket.open();
    expect(socket.sent).toEqual([
      { t: "sub", id: "1", channel: "item", scope: { key: "a" }, after: "s6t.app.1" },
      { t: "sub", id: "2", channel: "list", scope: {} },
    ]);

    socket.message({ t: "ready", id: "1", cursor: "s6t.app.1" });
    socket.message({ t: "ready", id: "2", cursor: "s6t.app.4" });
    socket.message({ t: "event", id: "1", cursor: "s6t.app.5", data: 5 });
    socket.message({ t: "event", id: "1", cursor: "s6t.app.6", data: 6 });
    await Bun.sleep(1);
    // A ready never reloads: the server replayed what the page missed.
    expect(first.log).toEqual(["apply:5", "apply:6"]);
    expect(second.log).toEqual([]);

    socket.close(1012, "restart");
    await elapse(Math.min(...timers.map((timer) => timer.delay).filter((delay) => delay < 10_000)));
    const next = FakeWebSocket.instances[1] as FakeWebSocket;
    next.open();
    expect(next.sent).toEqual([
      { t: "sub", id: "1", channel: "item", scope: { key: "a" }, after: "s6t.app.6" },
      { t: "sub", id: "2", channel: "list", scope: {}, after: "s6t.app.4" },
    ]);
    a.close();
    expect(next.sent.at(-1)).toEqual({ t: "unsub", id: "1" });
    b.close();
    expect(next.readyState).toBe(FakeWebSocket.CLOSED);
  });

  test("progress moves the cursor only after earlier events are applied", async () => {
    const live = recorder();
    live.failNext(1);
    const subscription = liveConnection("/api/app/live").subscribe("item", { key: "a" }, live.handlers());
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    socket.open();
    socket.message({ t: "ready", id: "1", cursor: "s6t.app.1" });
    socket.message({ t: "event", id: "1", cursor: "s6t.app.2", data: 2 });
    socket.message({ t: "progress", cursor: "s6t.app.9" });
    await Bun.sleep(1);
    socket.close(1013);
    const reconnect = Math.min(...timers.map((timer) => timer.delay).filter((delay) => delay < 1_000));
    await elapse(reconnect);
    const next = FakeWebSocket.instances[1] as FakeWebSocket;
    next.open();
    expect(next.sent[0]).toMatchObject({ after: "s6t.app.1" });

    await elapse(1_000);
    expect(live.log).toEqual(["apply:2", "apply:2"]);
    next.message({ t: "ready", id: "1", cursor: "s6t.app.9" });
    await Bun.sleep(1);
    next.close(1011);
    await elapse(Math.min(...timers.map((timer) => timer.delay).filter((delay) => delay < 10_000)));
    const third = FakeWebSocket.instances[2] as FakeWebSocket;
    third.open();
    expect(third.sent[0]).toMatchObject({ after: "s6t.app.9" });
    subscription.close();
  });

  test("a resync reloads once, drops the events queued before it, and applies the events after it in one batch", async () => {
    const live = recorder();
    let release = () => {};
    const handlers = live.handlers();
    const subscription = liveConnection("/api/app/live").subscribe(
      "item",
      { key: "a" },
      {
        ...handlers,
        apply: async (events) => {
          await handlers.apply(events);
          if (events[0]?.data === 1) await new Promise<void>((resolve) => (release = resolve));
        },
      },
    );
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    socket.open();
    socket.message({ t: "ready", id: "1", cursor: "s6t.app.1" });
    socket.message({ t: "event", id: "1", cursor: "s6t.app.2", data: 1 });
    await Bun.sleep(1);
    socket.message({ t: "event", id: "1", cursor: "s6t.app.3", data: 2 });
    socket.message({ t: "resync", id: "1", cursor: "s6t.app.4" });
    socket.message({ t: "event", id: "1", cursor: "s6t.app.5", data: 5 });
    socket.message({ t: "event", id: "1", cursor: "s6t.app.7", data: 7 });
    release();
    await Bun.sleep(5);
    // Events that arrive while an apply runs are applied together.
    expect(live.log).toEqual(["apply:1", "resync", "apply:5,7"]);

    // Data this page cannot read is covered by reloading the state.
    socket.message({ t: "event", id: "1", cursor: "s6t.app.6", data: "not a number" });
    await Bun.sleep(5);
    expect(live.log.at(-1)).toBe("resync");
    subscription.close();
  });

  test("a failing apply retries after 1, 3 and 9 seconds, then reports live updates unavailable", async () => {
    const live = recorder();
    live.failNext(4);
    liveConnection("/api/app/live").subscribe("item", { key: "a" }, live.handlers());
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    socket.open();
    socket.message({ t: "event", id: "1", cursor: "s6t.app.2", data: 2 });
    for (const delay of [1_000, 3_000, 9_000]) await elapse(delay);
    expect(live.log).toEqual(["apply:2", "apply:2", "apply:2", "apply:2", "unavailable"]);
    expect(socket.sent.at(-1)).toEqual({ t: "unsub", id: "1" });
  });

  test("revoked ends one subscription; a policy close ends all of them", () => {
    const first = recorder();
    const second = recorder();
    liveConnection("/api/app/live").subscribe("item", { key: "a" }, first.handlers());
    liveConnection("/api/app/live").subscribe("item", { key: "b" }, second.handlers());
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    socket.open();
    socket.message({ t: "revoked", id: "1", code: "access_denied" });
    socket.close(1008, "session_expired");
    expect(first.log).toEqual(["revoked:access_denied"]);
    expect(second.log).toEqual(["unavailable"]);
    liveConnection("/api/app/live").subscribe("item", { key: "a" }, recorder().handlers()).close();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
