import { resolve } from "node:path";
import { createPushRoutes } from "../server/routes";
import { startPush } from "../server/start";

// Index only the immutable build directory. Never resolve request paths on disk.
const root = resolve(import.meta.dir, "../dist");
const files = new Map<string, ReturnType<typeof Bun.file>>();
for await (const path of new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true })) {
  files.set(`/${path}`, Bun.file(resolve(root, path)));
}
for (const path of ["/index.html", "/sw.js", "/manifest.webmanifest"]) {
  if (!files.has(path)) throw new Error(`Missing production build: ${path}`);
}

const push = await startPush();
const pushRoutes = createPushRoutes(push?.push, (request) => server.requestIP(request)?.address);

const server = Bun.serve({
  port: Number(process.env.PORT || 3000),
  hostname: "0.0.0.0",
  async fetch(request) {
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    const path = new URL(request.url).pathname;
    if (path === "/push" || path.startsWith("/push/")) {
      const response = await pushRoutes.fetch(request);
      for (const [name, value] of headers) if (!response.headers.has(name)) response.headers.set(name, value);
      return response;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      headers.set("Allow", "GET, HEAD");
      return new Response(null, { status: 405, headers });
    }
    if (path === "/health") return new Response(request.method === "HEAD" ? null : "ok", { headers });
    const file = files.get(path === "/" ? "/index.html" : path);
    if (!file) return new Response(null, { status: 404, headers });
    headers.set("Content-Type", path.endsWith(".webmanifest") ? "application/manifest+json" : file.type);
    if (path.startsWith("/assets/")) headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(request.method === "HEAD" ? null : file, { headers });
  },
});
console.log(`Cloud Login listening on port ${server.port}${push ? " with push notifications" : ""}`);

const shutdown = async () => {
  await server.stop();
  await push?.stop();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
