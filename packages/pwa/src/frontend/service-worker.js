// The mobile app's service worker, scope `/pwa/`. The route prepends `const VERSION = "…";`.
// It handles navigations only and caches nothing but the offline page: every page and every API
// response comes from the network, so new versions of the shell and of the parts arrive with the next page.
const CACHE = `cloud-pwa-${VERSION}`;
const OFFLINE = "/pwa/offline";

self.addEventListener("install", (event) =>
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE, { cache: "reload", credentials: "omit", redirect: "error" })))
      .then(() => self.skipWaiting()),
  ),
);

self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith("cloud-pwa-") && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);

// A gateway error, or Core's 404 while the shell is not registered (for example during its restart).
const unavailable = (response) =>
  (response.status >= 502 && response.status <= 504) || (response.status === 404 && response.headers.get("X-Gateway-App") === "core");

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.mode !== "navigate" || url.origin !== location.origin || !url.pathname.startsWith("/pwa/")) return;
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(event.request);
        return unavailable(response) ? ((await caches.match(OFFLINE)) ?? response) : response;
      } catch {
        return (await caches.match(OFFLINE)) ?? Response.error();
      }
    })(),
  );
});
