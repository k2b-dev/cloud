import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dist } from "../scripts/build";

// Snapshot a production build so the dev server cannot replace files mid-test.
const root = await mkdtemp(join(tmpdir(), "cloud-login-offline-test-"));
await cp(dist, root, { recursive: true });
let version = 1;
Bun.serve({
  hostname: "127.0.0.1",
  port: 4179,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__test/reset" && req.method === "POST") {
      version = 1;
      return new Response("ok");
    }
    if (url.pathname === "/__test/next" && req.method === "POST") {
      version = 2;
      return new Response("ok");
    }
    if (req.method !== "GET") return new Response(null, { status: 405 });
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (path.includes("..")) return new Response(null, { status: 400 });
    const file = Bun.file(root + path);
    if (!(await file.exists())) return new Response(null, { status: 404 });
    let body: Blob | string = file;
    if (path === "/sw.js") body = (await file.text()).replaceAll(/cloud-login-shell-([a-f0-9]+)/g, `cloud-login-shell-$1-test${version}`);
    if (path === "/index.html") body = (await file.text()).replace("<body ", `<body data-test-version="${version}" `);
    return new Response(body, { headers: { "Content-Type": file.type, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  },
});
console.log("Isolated static PWA test: http://127.0.0.1:4179");
