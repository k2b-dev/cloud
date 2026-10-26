import type { BrowserContext, Page } from "playwright";

const refusalCodes = new Set(["forbidden_origin", "login_required", "missing_scope"]);
const safeReason = (reason: string) => (refusalCodes.has(reason) ? reason : "other");

/** Report only protocol metadata, never cookies, frame bodies, or server messages. */
export const watchGridsLiveSocket = (page: Page, report: (message: string) => void) => {
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/api/grids/live") return;
    socket.on("framereceived", ({ payload }) => {
      try {
        const frame: unknown = JSON.parse(String(payload));
        if (frame && typeof frame === "object" && "t" in frame && frame.t === "error") {
          const code = "code" in frame && typeof frame.code === "string" ? safeReason(frame.code) : "other";
          report(`grids live error code=${code}`);
        }
      } catch {
        // Application data is not diagnostic output.
      }
    });
  });
};

/** Match Chat's public-origin relay when Nightly reaches Cloud over loopback. */
export const relayGridsLiveSocket = async (
  context: BrowserContext,
  baseUrl: string,
  appOrigin: string,
  sessionToken: string | undefined,
  report: (message: string) => void,
) => {
  if (!sessionToken || appOrigin === new URL(baseUrl).origin) return;
  const socketUrl = new URL("/api/grids/live", baseUrl);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  // Grids also loads lib.dom: name Bun's header-capable overload explicitly, as in the Mail smoke runner.
  // The browser probe verifies that this runtime constructor forwards both Origin and the fixture session.
  const BunSocket = WebSocket as typeof WebSocket & { new (url: string, options: Bun.WebSocketOptions): WebSocket };
  await context.routeWebSocket(socketUrl.href, (route) => {
    const upstream = new BunSocket(route.url(), { headers: { Origin: appOrigin, Cookie: `session_token=${sessionToken}` } });
    const waiting: string[] = [];
    upstream.onopen = () => {
      for (const message of waiting.splice(0)) upstream.send(message);
    };
    upstream.onmessage = (event) => route.send(String(event.data));
    upstream.onclose = (event) => {
      waiting.length = 0;
      report(`grids live close code=${event.code} reason=${safeReason(event.reason)}`);
      // Reserved close codes describe a lost transport and cannot be sent as a close frame.
      const code = [1005, 1006, 1015].includes(event.code) ? 1011 : event.code;
      void route.close({ code, reason: event.reason }).catch(() => report("grids live browser close failed"));
    };
    upstream.onerror = () => {
      report("grids live upstream transport error");
      void route.close({ code: 1011, reason: "smoke_upstream_error" }).catch(() => report("grids live browser close failed"));
    };
    route.onMessage((message) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(String(message));
      else if (upstream.readyState === WebSocket.CONNECTING) waiting.push(String(message));
    });
    route.onClose((code, reason) => {
      waiting.length = 0;
      upstream.close(code, reason);
    });
  });
};
