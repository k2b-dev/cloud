// Scope /pwa/. The network-only worker route embeds OFFLINE_HTML, STATIC_ASSETS and CACHE_BYTES.
// CacheStorage is writable by every same-origin script: neither cached headers nor a cached integrity manifest
// is authority. The worker source pins SHA-256, length and MIME of final build output. Every cache read verifies
// the bytes and creates a fresh response with pinned headers. Bun chunk names and island IDs are NOT SHA-256.
// Only exact versioned JS/CSS/font URLs in that catalog can enter the cache; HTML, APIs and personal data never do.
// One currently registered build per app; activation removes URLs absent from the new catalog. All relative SSR
// imports inherit the build directory. No URL substitution or old-build fallback; safe reload stays with the page.
// The cache holds at most CACHE_BYTES (16 MiB, over twice the measured ~6 MiB Start/Chat/Spaces JS + shared CSS),
// evicting oldest writes. Entries are filled on demand, so installing never downloads unused parts or dialogs.
// Unversioned fonts remain network-only. Public static files hold no personal data and need no sign-out/unpair
// cleanup; the existing account-draft cleanup stays unchanged. Offline documents live only in this worker source.
const CACHE_NAME = "cloud-pwa-static-v1";
const assets = new Map(STATIC_ASSETS.map((asset) => [new URL(asset.url, location.origin).href, asset]));
let writes = Promise.resolve();
const offline = () => new Response(OFFLINE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });

const permitted = (response) => {
  const control = response.headers.get("Cache-Control") ?? "";
  return (
    response.status === 200 &&
    !response.redirected &&
    !response.headers.has("Set-Cookie") &&
    !/(?:^|,)\s*(?:private|no-store)\b/i.test(control) &&
    /(?:^|,)\s*immutable\s*(?:,|$)/i.test(control)
  );
};

// Read at most the pinned length, including when a page script planted a much larger streamed response.
const verify = async (response, asset, cacheable = true) => {
  if (response.status !== 200 || (cacheable && !permitted(response)) || !response.body) return;
  const reader = response.body.getReader();
  const body = new Uint8Array(asset.bytes);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > body.byteLength) return;
      body.set(value, size);
      size += value.byteLength;
    }
    if (size !== body.byteLength) return;
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (digest !== asset.sha256) return;
    const headers = cacheable
      ? new Headers({ "Content-Type": asset.type, "Cache-Control": "public, max-age=31536000, immutable" })
      : new Headers(response.headers);
    // Fetch exposes decoded bytes. A synthetic response must not claim they are still compressed.
    headers.delete("Content-Encoding");
    headers.delete("Content-Length");
    headers.set("Content-Type", asset.type);
    return new Response(body, { headers });
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

const prune = async (cache, incoming = 0, replacing) => {
  const keys = await cache.keys();
  const kept = [];
  let bytes = 0;
  for (const request of keys) {
    const asset = assets.get(request.url);
    const cached = asset && request.url !== replacing ? await cache.match(request) : undefined;
    if (!asset || !cached || !(await verify(cached, asset))) await cache.delete(request);
    else {
      kept.push(request);
      bytes += asset.bytes;
    }
  }
  for (const request of kept) {
    if (bytes + incoming <= CACHE_BYTES) break;
    await cache.delete(request);
    bytes -= assets.get(request.url).bytes;
  }
};

// Serialize writes/evictions so concurrent chunk downloads cannot exceed the byte budget.
const store = (request, response, asset) => {
  writes = writes
    .then(async () => {
      const cache = await caches.open(CACHE_NAME);
      await prune(cache, asset.bytes, request.url);
      await cache.put(request, response);
    })
    .catch(() => undefined); // Quota/private-mode failures leave the network response usable.
  return writes;
};

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      try {
        await prune(await caches.open(CACHE_NAME));
      } catch {} // Storage can be unavailable; online use still works.
      await self.clients.claim();
    })(),
  ),
);

// Core serves /pwa/_auth itself, so its 404 there is a real one.
const core = (url) => url.pathname === "/pwa/_auth" || url.pathname.startsWith("/pwa/_auth/");
const unavailable = (url, response) =>
  (response.status >= 502 && response.status <= 504) ||
  (response.status === 404 && response.headers.get("X-Gateway-App") === "core" && !core(url));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== location.origin || request.method !== "GET") return;
  if (request.mode === "navigate") {
    if (!url.pathname.startsWith("/pwa/")) return;
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          return unavailable(url, response) ? offline() : response;
        } catch {
          return offline();
        }
      })(),
    );
    return;
  }
  const asset = assets.get(url.href);
  if (!asset) {
    // A new document can arrive before the catalog update. The static server marks only its actual stylesheet
    // version immutable; accept that new URL from the network, without substituting a retired version.
    if (assets.size && url.searchParams.has("v") && /^\/public\/(?:(?:fonts|tabler-icons|global)|[^/]+\/app)\.css$/.test(url.pathname)) {
      event.respondWith(fetch(request).then((response) => (response.status === 200 && !permitted(response) ? Response.error() : response)));
    }
    return;
  }
  const answer = (async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) {
        const verified = await verify(cached, asset);
        if (verified) return verified;
        await cache.delete(request);
      }
    } catch {} // A missing/unavailable cache falls through to the network.
    const response = await fetch(request);
    if (response.status !== 200) return response;
    const cacheable = permitted(response);
    // Check build identity even if an upstream declines caching, and consume the original stream once.
    const verified = await verify(response, asset, cacheable);
    // A rolling deployment must not execute another build's bytes at a pinned URL.
    if (!verified) return Response.error();
    // Filling storage must not delay the already verified network response.
    if (cacheable) event.waitUntil(store(request, verified.clone(), asset));
    return verified;
  })();
  event.respondWith(answer);
  event.waitUntil(
    answer.then(
      () => undefined,
      () => undefined,
    ),
  );
});
