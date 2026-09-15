import { expect, test } from "bun:test";
import { once } from "node:events";
import { createConnection } from "node:net";
import type { ServerWebSocket } from "bun";
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
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
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
      message() {},
    },
  });
  const table = buildRouteTable([{ prefix: "/ws", appId: "test", baseUrl: upstream.url.href }]);
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return tryUpgradeWebSocket(request, server, table, () => {});
    },
    websocket: websocketHandlers,
  });
  return {
    upstream,
    gateway,
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

test.each([1000, 1013, 4000, 1006])("upstream close %s reaches the browser and frees both sides", async (code) => {
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
    expect(closed!.code).toBe(code === 1006 ? 1011 : code);
    if (code !== 1006) expect(closed!.reason).toBe("done");
    await until(() => f.gateway.pendingWebSockets === 0 && f.upstream.pendingWebSockets === 0);
  } finally {
    browser.close();
    await f.stop();
  }
});
