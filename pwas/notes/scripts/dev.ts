import { relative, resolve } from "node:path";
import { build, dist } from "./build";

const help = `Usage: bun run dev [--port 4190]

Builds the SPA in development mode and serves it with a rebuild on every page load.
Set NOTES_API_ORIGIN (for example http://127.0.0.1:4191) to forward /api to a running notes server.`;
if (process.argv.includes("--help")) {
  console.log(help);
  process.exit(0);
}

const portFlag = process.argv.indexOf("--port");
const port = Number(portFlag > 0 ? process.argv[portFlag + 1] : (process.env.PORT ?? 4190));
const api = process.env.NOTES_API_ORIGIN;

await build({ development: true });
type Bridge = { upstream: WebSocket; queue: (string | ArrayBuffer)[] };

let rebuilding: Promise<void> | undefined;
const server = Bun.serve<Bridge>({
  hostname: "127.0.0.1",
  port,
  // A rebuild on a busy machine can take longer than the default ten seconds.
  idleTimeout: 120,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (!api) return Response.json({ code: "unavailable", message: "No notes server configured" }, { status: 503 });
      const target = new URL(url.pathname + url.search, api);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        // The notes server checks Origin, so the bridge forwards the browser's own.
        target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
        // Bun's WebSocket takes request headers as a second argument; the DOM typing in this package does not know it.
        const upstream: WebSocket = Reflect.construct(WebSocket, [target, { headers: { Origin: request.headers.get("origin") ?? "" } }]);
        upstream.binaryType = "arraybuffer";
        if (server.upgrade(request, { data: { upstream, queue: [] } })) return;
        upstream.close();
        return new Response(null, { status: 400 });
      }
      return fetch(new Request(target, request));
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    const asset = url.pathname.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(url.pathname);
    if (!asset) {
      rebuilding ??= build({ development: true }).finally(() => {
        rebuilding = undefined;
      });
      await rebuilding;
    } else if (rebuilding) await rebuilding;
    const path = resolve(dist, asset ? `.${url.pathname}` : "index.html");
    if (relative(dist, path).startsWith("..")) return new Response(null, { status: 404 });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response(null, { status: 404 });
    return new Response(request.method === "HEAD" ? null : file, {
      headers: { "Content-Type": file.type, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  },
  websocket: {
    open(socket) {
      const { upstream, queue } = socket.data;
      upstream.onopen = () => {
        for (const message of queue.splice(0)) upstream.send(message);
      };
      upstream.onmessage = (event) => socket.send(event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : String(event.data));
      upstream.onclose = (event) => socket.close(event.code === 1005 ? 1000 : event.code, event.reason);
      upstream.onerror = () => socket.close(1011, "upstream_failed");
    },
    message(socket, message) {
      const { upstream, queue } = socket.data;
      const data = typeof message === "string" ? message : new Uint8Array(message).slice().buffer;
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
      else queue.push(data);
    },
    close(socket, code, reason) {
      socket.data.upstream.close(code === 1005 ? 1000 : code, reason);
    },
  },
});
console.log(`notes site → ${server.url} (reload to rebuild)`);
