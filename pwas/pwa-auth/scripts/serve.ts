import { resolve } from "node:path";

// Index only the immutable build directory. Never resolve request paths on disk.
const root = resolve(import.meta.dir, "../dist");
const files = new Map<string, ReturnType<typeof Bun.file>>();
for await (const path of new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true })) {
  files.set(`/${path}`, Bun.file(resolve(root, path)));
}
for (const path of ["/index.html", "/sw.js", "/manifest.webmanifest"]) {
  if (!files.has(path)) throw new Error(`Missing production build: ${path}`);
}

const server = Bun.serve({
  port: Number(process.env.PORT || 3000),
  hostname: "0.0.0.0",
  fetch(request) {
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    if (request.method !== "GET" && request.method !== "HEAD") {
      headers.set("Allow", "GET, HEAD");
      return new Response(null, { status: 405, headers });
    }
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response(request.method === "HEAD" ? null : "ok", { headers });
    const file = files.get(path === "/" ? "/index.html" : path);
    if (!file) return new Response(null, { status: 404, headers });
    headers.set("Content-Type", path.endsWith(".webmanifest") ? "application/manifest+json" : file.type);
    if (path.startsWith("/assets/")) headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(request.method === "HEAD" ? null : file, { headers });
  },
});
console.log(`Cloud Login listening on port ${server.port}`);
