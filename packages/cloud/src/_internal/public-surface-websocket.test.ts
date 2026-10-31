import { expect, test } from "bun:test";
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { PUBLIC_HOST_HEADER, PUBLIC_SURFACE_PREFIX } from "../contracts/app-domains";
import { createPublicSurfaceHandler } from "./public-surface";

for (const binding of ["direct", "nested"] as const) {
  test(`public routes upgrade a real Bun WebSocket with a ${binding} server binding`, async () => {
    const router = new Hono().get(
      "/socket",
      upgradeWebSocket((c) => {
        const transport = "server" in c.env ? c.env.server : c.env;
        const ip = transport.requestIP(c.req.raw)?.address;
        transport.timeout(c.req.raw, 5);
        return {
          onOpen: (_event, socket) => socket.send(JSON.stringify({ url: c.req.url, cookie: c.req.header("cookie"), ip })),
          onMessage: (event, socket) => socket.send(`echo:${event.data}`),
        };
      }),
    );
    const handler = createPublicSurfaceHandler(router, true);
    const upstream = new Hono().all(`${PUBLIC_SURFACE_PREFIX}/*`, handler);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      websocket,
      fetch(request, transport) {
        // Supply the upstream headers the gateway sends, while retaining Bun's native request identity.
        request.headers.set(PUBLIC_HOST_HEADER, "site.localhost:3100");
        request.headers.set("cookie", "session_token=secret; visitor=kept");
        return upstream.fetch(request, binding === "direct" ? transport : { server: transport });
      },
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}${PUBLIC_SURFACE_PREFIX}/socket?x=1`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const messages: string[] = [];
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Public WebSocket response timed out")), 3000);
        socket.onerror = () => reject(new Error("Public WebSocket upgrade failed"));
        socket.onmessage = (event) => {
          messages.push(String(event.data));
          if (messages.length === 1) socket.send("hello");
          else resolve();
        };
      });
      expect(JSON.parse(messages[0]!)).toEqual({ url: "http://site.localhost:3100/socket?x=1", cookie: "visitor=kept", ip: "127.0.0.1" });
      expect(messages[1]).toBe("echo:hello");
    } finally {
      clearTimeout(timer);
      socket.close();
      await server.stop(true);
    }
  }, 5000);
}
