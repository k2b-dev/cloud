/**
 * WebSocket proxying for the gateway.
 *
 * Mirrors the HTTP proxy: route the incoming Upgrade request through the
 * registry trie, then open a parallel WebSocket connection to the upstream
 * app container and bidirectionally relay frames.
 *
 * Pattern (same as Traefik / nginx / caddy):
 *   client ──HTTP Upgrade──► gateway ──WebSocket──► upstream
 *   client ◄────frames─────► gateway ◄────frames──► upstream
 *
 * Frames pass through opaquely. The gateway buffers any client frames that
 * arrive before the upstream socket is open so the initial Yjs sync packet
 * isn't lost during connection setup.
 */
import type { ServerWebSocket } from "bun";
import { isInternalPath } from "./request-boundary";
import { matchRoute, type RouteTable } from "./trie";

const MAX_PENDING_FRAMES = 32;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

type ProxyState = {
  appId: string;
  upstream: WebSocket;
  upstreamReady: boolean;
  closed: boolean;
  /** Frames received from client before upstream is open. Flushed on upstream `open`. */
  pending: (string | ArrayBufferLike | ArrayBufferView)[];
  pendingBytes: number;
  /**
   * Captured by the `open` websocket handler the first time Bun calls it.
   * Upstream-side event handlers reach this via the closure they share with
   * `tryUpgradeWebSocket`, so reading via `state.client` is the simplest way
   * to give them the `send` target without an extra capture function.
   */
  client: ServerWebSocket<ProxyData> | null;
};

type ProxyData = {
  state: ProxyState;
};

const frameBytes = (frame: string | ArrayBufferLike | ArrayBufferView): number => {
  if (typeof frame === "string") return Buffer.byteLength(frame);
  return frame.byteLength;
};

const clearPending = (state: ProxyState) => {
  state.pending = [];
  state.pendingBytes = 0;
};

const closeProxy = (state: ProxyState, code: number, reason: string) => {
  if (state.closed) return;
  state.closed = true;
  clearPending(state);
  try {
    state.upstream.close(code, reason);
  } catch {
    // The upstream connection may never have opened.
  }
  try {
    state.client?.close(code, reason);
  } catch {
    // The browser connection may already be closing.
  }
};

const sendUpstream = (state: ProxyState, frame: string | ArrayBufferLike | ArrayBufferView): boolean => {
  try {
    state.upstream.send(frame as never);
    return state.upstream.bufferedAmount <= MAX_BUFFERED_BYTES;
  } catch {
    return false;
  }
};

/**
 * Called from the gateway's fetch handler when an Upgrade: websocket request
 * arrives. Looks up the route, derives the upstream ws:// URL, opens the
 * parallel upstream connection, and asks Bun to upgrade the client side.
 *
 * Returns:
 * - `undefined` when the upgrade succeeded (Bun answers 101 automatically).
 * - a `Response` to return to the client when something failed.
 */
export const tryUpgradeWebSocket = (
  req: Request,
  server: { upgrade: (req: Request, options?: { data?: ProxyData; headers?: Record<string, string> }) => boolean },
  table: RouteTable,
  logFn: (msg: string, meta?: Record<string, unknown>) => void,
): Response | undefined => {
  const url = new URL(req.url);
  if (isInternalPath(url.pathname)) return new Response("Not found", { status: 404 });
  const match = matchRoute(table, url.pathname);
  if (!match) {
    return new Response("WebSocket: no app registered for this path", { status: 502 });
  }

  // ws:// upstream URL — preserve path and query.
  const upstream = new URL(url.pathname + url.search, match.baseUrl);
  upstream.protocol = "ws:";

  // Forward auth-relevant headers so the upstream's auth middleware sees the
  // same request the gateway saw. Bun's WebSocket constructor only honours
  // `headers` in the options bag (its built-in client variant).
  const forwardedHeaders: Record<string, string> = {};
  const cookie = req.headers.get("cookie");
  if (cookie) forwardedHeaders.Cookie = cookie;
  const auth = req.headers.get("authorization");
  if (auth) forwardedHeaders.Authorization = auth;
  forwardedHeaders["X-Forwarded-Host"] = url.host;
  forwardedHeaders["X-Forwarded-Proto"] = url.protocol.replace(":", "");

  let upstreamSocket: WebSocket;
  try {
    // Bun's WebSocket constructor accepts `{ headers }` as a second argument
    // (not in the standard lib types — pass via `as never` to bypass the
    // narrow `string | string[]` declaration that targets browser subprotocols).
    upstreamSocket = new WebSocket(upstream.href, { headers: forwardedHeaders } as never);
  } catch (err) {
    logFn("WebSocket upstream connect failed", {
      appId: match.appId,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response("WebSocket: upstream connect failed", { status: 502 });
  }

  const state: ProxyState = {
    appId: match.appId,
    upstream: upstreamSocket,
    upstreamReady: false,
    closed: false,
    pending: [],
    pendingBytes: 0,
    client: null,
  };

  // Upstream → client direction. Reads `state.client` lazily so the open
  // handler (which Bun fires synchronously inside `server.upgrade()`) gets
  // the chance to populate it. Earlier indirection via `_captureClient` was
  // assigned AFTER `upgrade()` and therefore missed the open call entirely.
  upstreamSocket.addEventListener("open", () => {
    if (state.closed) return;
    state.upstreamReady = true;
    // Flush any pending client frames now that upstream accepts them.
    for (const frame of state.pending) {
      if (sendUpstream(state, frame)) continue;
      closeProxy(state, 1013, "proxy backpressure");
      return;
    }
    clearPending(state);
  });

  upstreamSocket.addEventListener("message", (event) => {
    if (state.closed) return;
    // ServerWebSocket.send accepts string | BufferSource. Frame data from
    // the upstream WS comes through as either string or ArrayBuffer; both
    // are valid BufferSource — `as never` bypasses the narrow overload.
    const client = state.client;
    if (!client) {
      closeProxy(state, 1011, "proxy client unavailable");
      return;
    }
    try {
      client.send(event.data as never);
      // Bun 1.3 can report 0 after a larger frame already reached the peer.
      // Treat the bounded queue as the authoritative overload signal; an
      // actual connection failure is followed by the ordinary close event.
      if (client.getBufferedAmount() > MAX_BUFFERED_BYTES) {
        closeProxy(state, 1013, "proxy backpressure");
      }
    } catch {
      closeProxy(state, 1011, "proxy send failed");
    }
  });

  upstreamSocket.addEventListener("close", (event) => {
    closeProxy(state, event.code || 1000, event.reason || "upstream closed");
  });

  upstreamSocket.addEventListener("error", () => {
    logFn("WebSocket upstream error", { appId: match.appId });
    closeProxy(state, 1011, "upstream error");
  });

  const upgraded = server.upgrade(req, { data: { state } });
  if (!upgraded) {
    closeProxy(state, 1011, "upgrade failed");
    return new Response("WebSocket: upgrade failed", { status: 500 });
  }
  return undefined;
};

/**
 * Bun.serve `websocket` config object — registered once on the gateway.
 * Each handler dispatches against the per-connection ProxyData stored on
 * the ws instance via `server.upgrade({ data })`.
 */
export const websocketHandlers = {
  open(ws: ServerWebSocket<ProxyData>) {
    // Hand the client socket to the upstream-side handlers via shared state.
    // Direct assignment — Bun fires this synchronously inside server.upgrade(),
    // so any earlier indirection misses it.
    ws.data.state.client = ws;
  },

  message(ws: ServerWebSocket<ProxyData>, message: string | Buffer) {
    const { state } = ws.data;
    if (state.closed) return;
    if (state.upstreamReady) {
      if (!sendUpstream(state, message)) closeProxy(state, 1013, "proxy backpressure");
    } else {
      // Upstream still connecting — queue. Yjs sends sync immediately on connect.
      const bytes = frameBytes(message);
      if (state.pending.length >= MAX_PENDING_FRAMES || state.pendingBytes + bytes > MAX_PENDING_BYTES) {
        closeProxy(state, 1013, "proxy pending queue full");
        return;
      }
      state.pending.push(message as string | ArrayBufferLike | ArrayBufferView);
      state.pendingBytes += bytes;
    }
  },

  close(ws: ServerWebSocket<ProxyData>, code: number, reason: string) {
    closeProxy(ws.data.state, code || 1000, reason || "client closed");
  },
};
