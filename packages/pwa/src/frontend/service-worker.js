// The mobile app's service worker, scope `/pwa/`. The route prepends `const OFFLINE_HTML = "…";`.
// The offline page lives in this source, which only the network can change. CacheStorage would not do: any
// same-origin script can write to it, and a planted page would then run inside the app.
// The worker handles navigations only and caches nothing: every page and every API response comes from the network,
// so new versions of the shell and of the parts arrive with the next page.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const offline = () => new Response(OFFLINE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });

// Core serves /pwa/_auth itself, so its 404 there is a real one.
const core = (url) => url.pathname === "/pwa/_auth" || url.pathname.startsWith("/pwa/_auth/");
// A gateway error, or Core's 404 while the shell is not registered (for example during its restart).
const unavailable = (url, response) =>
  (response.status >= 502 && response.status <= 504) ||
  (response.status === 404 && response.headers.get("X-Gateway-App") === "core" && !core(url));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.mode !== "navigate" || url.origin !== location.origin || !url.pathname.startsWith("/pwa/")) return;
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(event.request);
        return unavailable(url, response) ? offline() : response;
      } catch {
        return offline();
      }
    })(),
  );
});
