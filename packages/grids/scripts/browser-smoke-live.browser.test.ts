import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, BrowserContext } from "playwright";
import { launchBrowser } from "../../ui/test/browser";
import { relayGridsLiveSocket, watchGridsLiveSocket } from "./browser-smoke-live";

const publicOrigin = "https://cloud.nightly-smoke.test";
const sessionToken = "smoke-fixture-session";
const privatePayload = "fixture-content-must-not-be-logged";
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

const probe = async (options: {
  relay: boolean;
  sameOrigin?: boolean;
  closeWithPrivateReason?: boolean;
  path?: string;
  anonymous?: boolean;
  rejectUpgrade?: boolean;
  relayOtherHost?: boolean;
}) => {
  const received: { origin: string | null; authenticated: boolean; path: string }[] = [];
  const diagnostics: string[] = [];
  const server = Bun.serve<{ refusal: "forbidden_origin" | "login_required" | null }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/")) {
        if (options.rejectUpgrade) return new Response(null, { status: 503 });
        const origin = request.headers.get("origin");
        const authenticated = request.headers.get("cookie") === `session_token=${sessionToken}`;
        received.push({ origin, authenticated, path });
        const expectedOrigin = options.sameOrigin ? server.url.origin : publicOrigin;
        const refusal = !authenticated ? "login_required" : origin !== expectedOrigin ? "forbidden_origin" : null;
        if (server.upgrade(request, { data: { refusal } })) return;
        return new Response(null, { status: 400 });
      }
      return new Response("<!doctype html><html><body>Socket probe</body></html>", { headers: { "Content-Type": "text/html" } });
    },
    websocket: {
      open(socket) {
        if (socket.data.refusal) {
          socket.send(JSON.stringify({ t: "error", code: socket.data.refusal, message: privatePayload }));
          socket.close(1008, socket.data.refusal);
        }
      },
      message(socket, message) {
        if (options.closeWithPrivateReason) socket.close(1008, privatePayload);
        else socket.send(message);
      },
    },
  });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext();
    if (!options.anonymous) {
      await context.addCookies([{ name: "session_token", value: sessionToken, url: server.url.origin, httpOnly: true }]);
    }
    if (options.relay) {
      const base = new URL(server.url);
      if (options.relayOtherHost) base.hostname = "localhost";
      await relayGridsLiveSocket(
        context,
        base.origin,
        options.sameOrigin ? server.url.origin : publicOrigin,
        options.anonymous ? undefined : sessionToken,
        (message) => diagnostics.push(message),
      );
    }
    const page = await context.newPage();
    watchGridsLiveSocket(page, (message) => diagnostics.push(message));
    await page.goto(server.url.origin);
    const result = await page.evaluate(
      ({ path, payload }) =>
        new Promise<{ code: number; reason: string; messages: string[] }>((resolve, reject) => {
          const socket = new WebSocket(new URL(path, location.origin).href.replace(/^http/, "ws"));
          const messages: string[] = [];
          socket.onopen = () => socket.send(payload);
          socket.onmessage = (event) => {
            messages.push(String(event.data));
            if (event.data === payload) socket.close(1000, "done");
          };
          socket.onclose = (event) => resolve({ code: event.code, reason: event.reason, messages });
          socket.onerror = () => reject(new Error("Socket probe failed"));
        }),
      { path: options.path ?? "/api/grids/live", payload: privatePayload },
    );
    return { result, received, diagnostics };
  } finally {
    try {
      await context?.close();
    } finally {
      await server.stop(true);
    }
  }
};

test("the unrelayed loopback browser sends its own origin and records only the refusal code", async () => {
  const { result, received, diagnostics } = await probe({ relay: false });
  expect(received).toHaveLength(1);
  expect(received[0]?.origin).toStartWith("http://127.0.0.1:");
  expect(received[0]?.authenticated).toBe(true);
  expect(result).toMatchObject({ code: 1008, reason: "forbidden_origin" });
  expect(diagnostics).toEqual(["grids live error code=forbidden_origin"]);
  expect(diagnostics.join()).not.toContain(privatePayload);
  expect(diagnostics.join()).not.toContain(sessionToken);
});

test("the relay authenticates at the public origin and forwards page messages and closure", async () => {
  const { result, received } = await probe({ relay: true });
  expect(received).toEqual([{ origin: publicOrigin, authenticated: true, path: "/api/grids/live" }]);
  expect(result).toEqual({ code: 1000, reason: "done", messages: [privatePayload] });
});

test("the relay reports close metadata without printing an arbitrary reason", async () => {
  const { result, diagnostics } = await probe({ relay: true, closeWithPrivateReason: true });
  expect(result).toMatchObject({ code: 1008, reason: privatePayload });
  expect(diagnostics).toEqual(["grids live close code=1008 reason=other"]);
});

test("a same-origin browser needs no relay", async () => {
  const { result, received, diagnostics } = await probe({ relay: true, sameOrigin: true });
  expect(received[0]?.origin).toStartWith("http://127.0.0.1:");
  expect(result).toEqual({ code: 1000, reason: "done", messages: [privatePayload] });
  expect(diagnostics).toEqual([]);
});

test("the relay leaves other application sockets alone", async () => {
  const { result, received, diagnostics } = await probe({ relay: true, path: "/api/other/live" });
  expect(received[0]?.origin).toStartWith("http://127.0.0.1:");
  expect(result).toMatchObject({ code: 1008, reason: "forbidden_origin" });
  expect(diagnostics).toEqual([]);
});

test("the relay leaves another host's socket alone", async () => {
  const { result, received } = await probe({ relay: true, relayOtherHost: true });
  expect(received[0]?.origin).toStartWith("http://127.0.0.1:");
  expect(result).toMatchObject({ code: 1008, reason: "forbidden_origin" });
});

test("an anonymous page does not receive a relayed session", async () => {
  const { result, received, diagnostics } = await probe({ relay: true, anonymous: true });
  expect(received[0]?.authenticated).toBe(false);
  expect(result).toMatchObject({ code: 1008, reason: "login_required" });
  expect(diagnostics).toEqual(["grids live error code=login_required"]);
});

test("an upstream transport failure is visible and closes the browser socket", async () => {
  const { result, diagnostics } = await probe({ relay: true, rejectUpgrade: true });
  expect(result.code).toBe(1011);
  expect(diagnostics).toContain("grids live upstream transport error");
  expect(diagnostics.join()).not.toContain(privatePayload);
  expect(diagnostics.join()).not.toContain(sessionToken);
});
