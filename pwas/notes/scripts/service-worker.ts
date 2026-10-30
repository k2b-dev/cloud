import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

/** Pages the SPA owns; offline they all answer with the cached app shell. Notes never enter the cache. */
const SHELL_ROUTES = ["/", "/n/", "/p/", "/beispiel", "/datenschutz", "/nutzungsbedingungen", "/impressum"];

export async function writeServiceWorker(dist: string) {
  const assets = (await readdir(resolve(dist, "assets"))).map((name) => `/assets/${name}`);
  const shell = ["/", "/manifest.webmanifest", "/favicon.svg", "/cloud-logo.svg", ...assets];
  const hash = new Bun.CryptoHasher("sha256");
  for (const path of shell) hash.update(await Bun.file(resolve(dist, path === "/" ? "index.html" : path.slice(1))).arrayBuffer());
  const version = hash.digest("hex").slice(0, 20);
  await Bun.write(
    resolve(dist, "sw.js"),
    `const CACHE = "notes-shell-${version}";
const SHELL = ${JSON.stringify(shell)};
const ROUTES = ${JSON.stringify(SHELL_ROUTES)};
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      for (const path of SHELL) {
        const response = await fetch(new Request(path, { cache: "reload", credentials: "omit", redirect: "error" }));
        if (!response.ok) throw new Error("App shell download failed");
        await cache.put(path, response);
      }
    } catch (error) { await caches.delete(CACHE); throw error; }
  })());
});
// No skipWaiting: an open tab keeps its coherent set of chunks until it reloads.
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("notes-shell-") && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  const page = event.request.mode === "navigate" && ROUTES.some((route) => route === "/" ? url.pathname === "/" : url.pathname.startsWith(route));
  const path = page ? "/" : url.pathname;
  if (!SHELL.includes(path)) return;
  event.respondWith((async () => {
    // Pages try the network first so /p/… keeps its link preview tags; assets are immutable by name.
    if (page) {
      try {
        const response = await fetch(event.request);
        if (response.ok) return response;
      } catch {}
    }
    const cached = await (await caches.open(CACHE)).match(path);
    return cached || fetch(event.request);
  })());
});
`,
  );
}
