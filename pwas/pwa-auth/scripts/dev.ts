import { relative, resolve } from "node:path";
import { build, dist } from "./build";

await build({ development: true });
// A reload rebuilds the source. Keep one build in flight for concurrent tabs.
let rebuilding: Promise<void> | undefined;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4178),
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      rebuilding ??= build({ development: true }).finally(() => {
        rebuilding = undefined;
      });
      await rebuilding;
    } else if (rebuilding) await rebuilding;
    const path = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (relative(dist, path).startsWith("..")) return new Response(null, { status: 404 });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response(null, { status: 404 });
    return new Response(request.method === "HEAD" ? null : file, {
      headers: { "Content-Type": file.type, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  },
});
console.log(`pwa-auth → ${server.url} (reload to rebuild)`);
