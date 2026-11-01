import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Pages the SPA owns; offline they all answer with the cached app shell. Notes never enter the cache. */
const SHELL_ROUTES = ["/", "/n/", "/p/", "/beispiel", "/datenschutz", "/nutzungsbedingungen", "/impressum"];

/**
 * The entry script, the stylesheet, the chunks the entry loads itself (such as the editor presentation) and all their
 * static imports. Deeper lazy chunks, such as diagram renderers, join the cache when they first load.
 */
async function startAssets(dist: string) {
  const names = await readdir(resolve(dist, "assets"));
  const read = (name: string) => readFile(resolve(dist, "assets", name), "utf8");
  const start = names.filter((name) => name.endsWith(".css") || (name.startsWith("main-") && name.endsWith(".js")));
  for (const main of start.filter((name) => name.endsWith(".js")))
    for (const match of (await read(main)).matchAll(/import\(\s*"\.\/([\w.-]+\.js)"\s*\)/g)) if (match[1]) start.push(match[1]);
  const seen = new Set<string>();
  for (let name = start.pop(); name !== undefined; name = start.pop()) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!name.endsWith(".js")) continue;
    for (const match of (await read(name)).matchAll(/(?:from|import)\s*"\.\/([\w.-]+\.js)"/g)) if (match[1]) start.push(match[1]);
  }
  return [...seen].map((name) => `/assets/${name}`);
}

export async function writeServiceWorker(dist: string) {
  const shell = ["/", "/manifest.webmanifest", "/favicon.svg", "/cloud-logo.svg", ...(await startAssets(dist))];
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
  // Lazy chunks are immutable by name, so the first answer stays in the cache for offline use.
  if (!page && url.pathname.startsWith("/assets/") && !SHELL.includes(path)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(path);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(path, response.clone());
      return response;
    })());
    return;
  }
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
