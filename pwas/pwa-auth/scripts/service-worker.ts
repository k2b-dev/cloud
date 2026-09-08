import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function writeServiceWorker(dist: string) {
  const assets = (await readdir(resolve(dist, "assets"))).map((name) => `/assets/${name}`);
  const shell = [
    "/",
    "/manifest.webmanifest",
    "/favicon.svg",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/icons/apple-touch-icon.png",
    ...assets,
  ];
  const hash = new Bun.CryptoHasher("sha256");
  for (const path of shell) hash.update(await Bun.file(resolve(dist, path === "/" ? "index.html" : path.slice(1))).arrayBuffer());
  const version = hash.digest("hex").slice(0, 20);
  await Bun.write(
    resolve(dist, "sw.js"),
    `
const CACHE = "cloud-login-shell-${version}";
const SHELL = ${JSON.stringify(shell)};
self.addEventListener("install", event => {
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
// No skipWaiting: keep every open app on its current coherent version.
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("cloud-login-shell-") && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  const path = event.request.mode === "navigate" && (url.pathname === "/" || url.pathname === "/index.html") ? "/" : url.pathname;
  if (!SHELL.includes(path) || (event.request.mode !== "navigate" && url.search)) return;
  event.respondWith((async () => {
    const cached = await (await caches.open(CACHE)).match(path);
    return cached || new Response("App files unavailable. Reopen Cloud Login online.", { status: 503, headers: { "Content-Type": "text/plain" } });
  })());
});
`,
  );
}
