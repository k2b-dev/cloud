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
let rebuilding: Promise<void> | undefined;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (!api) return Response.json({ code: "unavailable", message: "No notes server configured" }, { status: 503 });
      return fetch(new Request(new URL(url.pathname + url.search, api), request));
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
});
console.log(`notes site → ${server.url} (reload to rebuild)`);
