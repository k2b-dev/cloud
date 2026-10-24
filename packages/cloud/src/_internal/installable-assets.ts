import { resolve } from "node:path";
import { Hono } from "hono";
import type { AppInstallable } from "../contracts/installable";
import { escapeHtml } from "../shared/markdown/shared";

export const INSTALLABLE_ICON_VARIANTS = {
  "icon-192": { size: 192, box: 0.84 },
  "icon-512": { size: 512, box: 0.84 },
  // The square fits inside the maskable safe circle of radius 40%.
  "icon-maskable-512": { size: 512, box: 0.56 },
  "apple-touch-icon": { size: 180, box: 0.7 },
} as const;

export const installableManifest = (app: AppInstallable, theme: "light" | "dark") => ({
  id: app.path,
  start_url: app.path,
  scope: app.path,
  name: app.name,
  short_name: app.shortName,
  display: app.display,
  theme_color: app.themeColor[theme],
  background_color: app.themeColor[theme],
  icons: [
    { src: `${app.path}icon-192-${theme}.png`, sizes: "192x192", type: "image/png", purpose: "any" },
    { src: `${app.path}icon-512-${theme}.png`, sizes: "512x512", type: "image/png", purpose: "any" },
    { src: `${app.path}icon-maskable-512-${theme}.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});

/** One public bilingual document. It never includes a request, account, or application payload. */
export const installableOfflineHtml = (app: AppInstallable): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(app.name)} · Offline</title><meta name="referrer" content="no-referrer">
<style>:root{color-scheme:light dark;font-family:system-ui;background:#fafafa;color:#111}body{margin:0;padding: max(24px,env(safe-area-inset-top)) max(24px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left))}main{max-width:36rem;margin:10vh auto}button{font:inherit;min-height:44px;padding:8px 20px;cursor:pointer}@media(prefers-color-scheme:dark){:root{background:#090d12;color:#fff}}</style>
</head><body><main><h1>${escapeHtml(app.name)}</h1><p>You're offline. Connect to the internet and try again.</p><p lang="de">Du bist offline. Verbinde dich mit dem Internet und versuche es erneut.</p><button type="button">Try again / Erneut versuchen</button></main><script>document.querySelector('button').addEventListener('click',()=>location.reload())</script></body></html>`;

/** No cache storage, install/activate shortcuts, client messages, or private response retention. */
export const installableWorker = (app: AppInstallable): string => `"use strict";
const scope = ${JSON.stringify(app.path)};
const offline = ${JSON.stringify(installableOfflineHtml(app))};
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || request.mode !== "navigate" || url.origin !== self.location.origin || !url.pathname.startsWith(scope)) return;
  event.respondWith(fetch(request).catch(() => new Response(offline, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }
  })));
});
`;

/** Framework mounts before app access/auth and never delegates a missing generated file to app code. */
export const createInstallableRoutes = (appId: string, app: AppInstallable, publicDir = resolve(process.cwd(), "public")) => {
  const router = new Hono();
  const headers = { "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" };
  router.get(app.path.slice(0, -1), (c) => {
    const url = new URL(c.req.url);
    return c.redirect(`${app.path}${url.search}`, 308);
  });
  router.all(`${app.path}manifest.webmanifest`, (c) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Method Not Allowed", 405, { Allow: "GET, HEAD" });
    return new Response(
      c.req.method === "HEAD" ? null : JSON.stringify(installableManifest(app, c.req.query("theme") === "dark" ? "dark" : "light")),
      {
        headers: { ...headers, "Content-Type": "application/manifest+json" },
      },
    );
  });
  for (const [name, content, type] of [
    ["sw.js", installableWorker(app), "text/javascript; charset=utf-8"],
    ["offline.html", installableOfflineHtml(app), "text/html; charset=utf-8"],
  ] as const) {
    router.all(`${app.path}${name}`, (c) => {
      if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Method Not Allowed", 405, { Allow: "GET, HEAD" });
      return new Response(c.req.method === "HEAD" ? null : content, { headers: { ...headers, "Content-Type": type } });
    });
  }
  for (const theme of ["light", "dark"] as const) {
    for (const name of Object.keys(INSTALLABLE_ICON_VARIANTS)) {
      const filename = `${name}-${theme}.png`;
      router.all(`${app.path}${filename}`, async (c) => {
        if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Method Not Allowed", 405, { Allow: "GET, HEAD" });
        const file = Bun.file(resolve(publicDir, appId, "installable", filename));
        if (!(await file.exists())) return c.notFound();
        return new Response(c.req.method === "HEAD" ? null : file, { headers: { ...headers, "Content-Type": "image/png" } });
      });
    }
  }
  return router;
};
