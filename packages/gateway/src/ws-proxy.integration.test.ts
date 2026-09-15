import { expect, test } from "bun:test";
import { once } from "node:events";
import { createConnection } from "node:net";
import type { ServerWebSocket } from "bun";
import { createLiveWebSocket } from "@k2b/cloud/browser/live";
import { buildRouteTable } from "./trie";
import { tryUpgradeWebSocket, websocketHandlers } from "./ws-proxy";

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
  expect(condition()).toBe(true);
};

const fixture = (delayHandshake = false) => {
  let peer: ServerWebSocket<undefined> | undefined;
  let requested = false;
  let handshakeDone = false;
  let releaseHandshake = () => {};
  const handshake = new Promise<void>((resolve) => {
    releaseHandshake = resolve;
  });
  const messages: string[] = [];
  const errors: string[] = [];
  const startUpstream = (port: number) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      async fetch(request, server) {
        requested = true;
        if (delayHandshake) await handshake;
        const upgraded = server.upgrade(request);
        handshakeDone = true;
        if (upgraded) return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        open(ws: ServerWebSocket<undefined>) {
          peer = ws;
        },
        message(ws, message) {
          messages.push(String(message));
          ws.send(message);
        },
      },
    });
  let upstream = startUpstream(0);
  const upstreamPort = upstream.port!;
  const table = buildRouteTable([{ prefix: "/ws", appId: "test", baseUrl: upstream.url.href }]);
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return tryUpgradeWebSocket(request, server, table, (message) => errors.push(message));
    },
    websocket: websocketHandlers,
  });
  return {
    upstream,
    gateway,
    messages,
    errors,
    restartUpstream() {
      upstream = startUpstream(upstreamPort);
    },
    peer: () => peer,
    requested: () => requested,
    handshakeDone: () => handshakeDone,
    releaseHandshake,
    async stop() {
      releaseHandshake();
      await gateway.stop(true);
      await upstream.stop(true);
    },
  };
};

test.each([false, true])("TCP disconnect cancels the upstream (handshake delayed: %s)", async (delayed) => {
  const f = fixture(delayed);
  const raw = createConnection({ host: "127.0.0.1", port: f.gateway.port! });
  try {
    await once(raw, "connect");
    const response = once(raw, "data");
    raw.write(
      `GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    expect(String((await response)[0])).toContain("101 Switching Protocols");
    await until(() => (delayed ? f.requested() : !!f.peer()));
    raw.destroy();
    await until(() => f.gateway.pendingWebSockets === 0);
    f.releaseHandshake();
    await until(() => f.handshakeDone() && f.upstream.pendingWebSockets === 0 && (!f.peer() || f.peer()!.readyState === 3));
  } finally {
    raw.destroy();
    await f.stop();
  }
});

test.each([1000, 1008, 1011, 1013, 4000, 1006])("upstream close %s reaches the browser and frees both sides", async (code) => {
  const f = fixture();
  const browser = new WebSocket(new URL("/ws", f.gateway.url).href.replace("http:", "ws:"));
  let closed: CloseEvent | undefined;
  browser.addEventListener("close", (event) => {
    closed = event;
  });
  try {
    await until(() => !!f.peer() && browser.readyState === WebSocket.OPEN);
    if (code === 1006) f.peer()!.terminate();
    else f.peer()!.close(code, "done");
    await until(() => !!closed);
    expect(closed!.code).toBe(code === 1006 ? 1012 : code);
    if (code !== 1006) expect(closed!.reason).toBe("done");
    await until(() => f.gateway.pendingWebSockets === 0 && f.upstream.pendingWebSockets === 0);
  } finally {
    browser.close();
    await f.stop();
  }
});

test.each([false, true])("Cloud live client resumes after upstream loss (server restart: %s)", async (restart) => {
  const f = fixture();
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  // Use the real WebSocket transport; only provide the browser environment checks.
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: f.gateway.url.origin } } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
  const received: string[] = [];
  const fatal: string[] = [];
  const live = createLiveWebSocket({
    url: new URL("/ws", f.gateway.url).href,
    activity: "always",
    initialCursor: "first",
    subscribe: (cursor) => ({ cursor }),
    parse: (raw) => raw,
    onMessage: (message) => received.push(message),
    onFatal: (error) => fatal.push(error.code),
    reconnect: { baseDelayMs: 10, maxDelayMs: 50, jitterMs: 0 },
  });
  try {
    live.connect();
    await until(() => received.length === 1);
    expect(f.messages).toEqual([JSON.stringify({ cursor: "first" })]);
    live.markApplied("applied");
    if (restart) {
      await f.upstream.stop(true);
      // Prove a failed reconnect while the application is still unavailable.
      await until(() => f.errors.length > 0);
      f.restartUpstream();
    } else {
      f.peer()!.terminate();
    }
    await until(() => received.length === 2 || fatal.length > 0);
    expect(fatal).toEqual([]);
    expect(received).toEqual([JSON.stringify({ cursor: "first" }), JSON.stringify({ cursor: "applied" })]);
    expect(f.messages).toEqual(received);
    live.dispose();
    await until(() => f.gateway.pendingWebSockets === 0);
  } finally {
    live.dispose();
    await f.stop();
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
