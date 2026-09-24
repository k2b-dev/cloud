import { expect, mock, test } from "bun:test";
import type { Context } from "hono";
import { WSContext, type WSEvents } from "hono/ws";

// Keep the module fixture inside its own process so package-wide test runs
// never replace the real application modules used by other suites.
if (process.env.SPACES_WS_CHILD !== "1") {
  test("live subscription failures close retryably", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, SPACES_WS_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  }, 60_000);
} else {
  const fixture = { permission: "read" as string | null };
  let events: WSEvents | undefined;
  mock.module("@k2b/cloud/server", () => ({
    getLocale: () => "en",
    hasPermission: (permission: string | null) => permission !== null,
    auth: { session: { getToken: () => "session", authenticate: async () => ({ user: { id: "user" } }) } },
  }));
  mock.module("@k2b/cloud/services", () => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  }));
  mock.module("hono/bun", () => ({
    upgradeWebSocket: (factory: (context: Context) => WSEvents) => (context: Context) => {
      events = factory(context);
      return new Response("fixture");
    },
  }));
  mock.module("./service", () => ({
    spacesService: {
      space: {
        get: async () => ({ id: "space-uuid" }),
        permission: { get: async () => fixture.permission },
      },
    },
  }));
  mock.module("./service/public-resources", () => ({
    spacesPublicResources: { resolvePublicId: async () => "space-uuid" },
  }));
  mock.module("./service/events", () => ({
    latestSpaceEventCursor: async () => {
      throw new Error("JetStream unavailable");
    },
    liveSpaceEvents: async function* () {},
  }));

  const { default: app } = await import("./ws");

  const subscribe = async () => {
    await app.request("/");
    const handlers = events!;
    const sent: Array<{ type: string; payload: { code?: string } }> = [];
    const closed = Promise.withResolvers<{ code: number; reason: string }>();
    const raw = {
      send: (data: string) => sent.push(JSON.parse(data)),
      close: (code: number, reason: string) => closed.resolve({ code, reason }),
    };
    const socket = new WSContext({ raw, readyState: 1, send: () => {}, close: () => {} });
    handlers.onOpen?.(new Event("open"), socket);
    handlers.onMessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "spaces.live.subscribe", payload: { spaceId: "Space1", fromCursor: null } }),
      }),
      socket,
    );
    return { sent, close: await closed.promise };
  };

  test("a failing cursor lookup closes with 1012 so the client reconnects instead of reloading", async () => {
    fixture.permission = "read";
    const { sent, close } = await subscribe();
    expect(close).toEqual({ code: 1012, reason: "temporarily_unavailable" });
    expect(sent.map((message) => message.type)).toEqual(["spaces.live.error"]);
  });

  test("a denied subscription still closes as a fatal revocation", async () => {
    fixture.permission = null;
    const { sent, close } = await subscribe();
    expect(close).toEqual({ code: 1008, reason: "access_denied" });
    expect(sent.map((message) => message.type)).toEqual(["spaces.live.revoked"]);
  });
}
