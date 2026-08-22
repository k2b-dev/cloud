import { afterEach, describe, expect, test } from "bun:test";
import { buildRouteTable } from "./trie";
import { tryUpgradeWebSocket, websocketHandlers } from "./ws-proxy";

class FakeUpstream extends EventTarget {
  static instances: FakeUpstream[] = [];

  readonly sent: unknown[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  bufferedAmount = 0;

  constructor(
    readonly url: string,
    readonly options?: unknown,
  ) {
    super();
    FakeUpstream.instances.push(this);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.closes.push({ code, reason });
  }

  open() {
    this.dispatchEvent(new Event("open"));
  }

  message(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

type GatewaySocket = Parameters<typeof websocketHandlers.open>[0];

const originalWebSocket = globalThis.WebSocket;

const setup = (upgrade = true) => {
  FakeUpstream.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeUpstream;
  let data: GatewaySocket["data"] | null = null;
  const response = tryUpgradeWebSocket(
    new Request("http://cloud.test/api/mail/ws", { headers: { Upgrade: "websocket", Cookie: "session_token=test" } }),
    {
      upgrade: (_request, options) => {
        data = options?.data ?? null;
        return upgrade;
      },
    },
    buildRouteTable([{ prefix: "/api/mail", appId: "mail", baseUrl: "http://mail.test" }]),
    () => undefined,
  );
  return { response, data: () => data };
};

const clientFor = (data: GatewaySocket["data"], sendStatus = 1, bufferedAmount = 0) => {
  const closes: Array<{ code: number; reason: string }> = [];
  const client = {
    data,
    send: () => sendStatus,
    getBufferedAmount: () => bufferedAmount,
    close: (code = 1000, reason = "") => closes.push({ code, reason }),
  } as unknown as GatewaySocket;
  websocketHandlers.open(client);
  return { client, closes };
};

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
  FakeUpstream.instances = [];
});

describe("gateway WebSocket proxy", () => {
  test("bounds frames queued before the upstream opens", () => {
    const connection = setup();
    expect(connection.response).toBeUndefined();
    const data = connection.data();
    if (!data) throw new Error("Gateway upgrade data missing");
    const { client, closes } = clientFor(data);

    for (let index = 0; index < 33; index++) websocketHandlers.message(client, "x");

    expect(closes).toEqual([{ code: 1013, reason: "proxy pending queue full" }]);
    expect(FakeUpstream.instances[0]!.closes).toEqual([{ code: 1013, reason: "proxy pending queue full" }]);
  });

  test("bounds bytes queued before the upstream opens", () => {
    const connection = setup();
    const data = connection.data();
    if (!data) throw new Error("Gateway upgrade data missing");
    const { client, closes } = clientFor(data);

    websocketHandlers.message(client, Buffer.alloc(1024 * 1024 + 1));

    expect(closes).toEqual([{ code: 1013, reason: "proxy pending queue full" }]);
    expect(FakeUpstream.instances[0]!.closes).toEqual([{ code: 1013, reason: "proxy pending queue full" }]);
  });

  test("flushes queued frames in order when the upstream opens", () => {
    const connection = setup();
    const data = connection.data();
    if (!data) throw new Error("Gateway upgrade data missing");
    const { client, closes } = clientFor(data);

    websocketHandlers.message(client, "first");
    websocketHandlers.message(client, "second");
    FakeUpstream.instances[0]!.open();

    expect(FakeUpstream.instances[0]!.sent).toEqual(["first", "second"]);
    expect(closes).toEqual([]);
  });

  test("keeps an open proxy when Bun reports zero for a delivered frame", () => {
    const connection = setup();
    const data = connection.data();
    if (!data) throw new Error("Gateway upgrade data missing");
    const { closes } = clientFor(data, 0);
    FakeUpstream.instances[0]!.open();
    FakeUpstream.instances[0]!.message("mail event");

    expect(closes).toEqual([]);
    expect(FakeUpstream.instances[0]!.closes).toEqual([]);
  });

  test("closes both sides when the browser buffer exceeds its bound", () => {
    const connection = setup();
    const data = connection.data();
    if (!data) throw new Error("Gateway upgrade data missing");
    const { closes } = clientFor(data, -1, 4 * 1024 * 1024 + 1);
    FakeUpstream.instances[0]!.open();
    FakeUpstream.instances[0]!.message("mail event");

    expect(closes).toEqual([{ code: 1013, reason: "proxy backpressure" }]);
    expect(FakeUpstream.instances[0]!.closes).toEqual([{ code: 1013, reason: "proxy backpressure" }]);
  });

  test("closes the upstream when the browser upgrade fails", () => {
    const connection = setup(false);

    expect(connection.response?.status).toBe(500);
    expect(FakeUpstream.instances[0]!.closes).toEqual([{ code: 1011, reason: "upgrade failed" }]);
  });
});
