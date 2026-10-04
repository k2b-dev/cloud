import { createHash } from "node:crypto";
import { PWA_CANVAS_COLORS, PWA_SCOPE } from "@k2b/cloud/contracts";
import { coreSettings } from "@k2b/cloud/services";
import { appIconVersion, readAppIconSource } from "@k2b/cloud/services/branding/app-icon-source";
import { CLOUD_LOGO_SVG, LOCALE_COOKIE, themeBootstrapScript } from "@k2b/cloud/shared";
import type { Context } from "hono";
import { shellMessages } from "../messages";
import workerSource from "./service-worker.js" with { type: "text" };

/** The offline page inlines the logo only up to this size; a larger one gives way to the Cloud logo. */
const OFFLINE_LOGO_MAX_BYTES = 64 * 1024;

const hash = (...parts: string[]) => {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part);
  return digest.digest("hex");
};

/** True when the request's `If-None-Match` names this entity tag, weakly compared. */
const notModified = (c: Context, etag: string): boolean =>
  !!c.req
    .header("If-None-Match")
    ?.split(",")
    .some((tag) => [etag, `W/${etag}`, "*"].includes(tag.trim()));

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const appName = async (): Promise<string> => (await coreSettings.get<string>("app.name")) || "Cloud";

/**
 * The web app manifest. It is the same for everyone: no tokens and nothing per request. A manifest has one theme and
 * background colour, so both use the light canvas; each page sets its own colour for dark.
 */
export const manifestResponse = async (c: Context) => {
  const name = await appName();
  const version = await appIconVersion();
  const icon = (file: string, purpose: "any" | "maskable", size: number) => ({
    src: `/branding/${file}.png?v=${version}`,
    sizes: `${size}x${size}`,
    type: "image/png",
    purpose,
  });
  const body = JSON.stringify({
    id: PWA_SCOPE,
    name,
    short_name: name,
    start_url: PWA_SCOPE,
    scope: PWA_SCOPE,
    display: "standalone",
    background_color: PWA_CANVAS_COLORS.light,
    theme_color: PWA_CANVAS_COLORS.light,
    lang: (await coreSettings.get<string>("app.locale")) || "en",
    icons: [icon("pwa-icon-192", "any", 192), icon("pwa-icon-512", "any", 512), icon("pwa-icon-maskable-512", "maskable", 512)],
  });
  const etag = `"${hash(body).slice(0, 32)}"`;
  const headers = { "Cache-Control": "no-cache", ETag: etag };
  if (notModified(c, etag)) return c.body(null, 304, headers);
  return c.body(body, 200, { ...headers, "Content-Type": "application/manifest+json" });
};

/**
 * The page the service worker shows when Cloud or the app cannot be reached. Self-contained: inline styles, the logo
 * as a data URI, both languages; nothing about the account.
 */
const offlineDocument = async (): Promise<string> => {
  const cloud = await appName();
  const source = await readAppIconSource();
  const logo =
    source.data.byteLength <= OFFLINE_LOGO_MAX_BYTES
      ? `data:${source.mime};base64,${Buffer.from(source.data).toString("base64")}`
      : `data:image/svg+xml;base64,${Buffer.from(CLOUD_LOGO_SVG).toString("base64")}`;
  const section = (locale: "en" | "de") => {
    const { t } = shellMessages.resolve([locale]);
    return `<section lang="${locale}"${locale === "en" ? "" : " hidden"}>
      <h1>${escapeHtml(t.offlineTitle({ cloud }))}</h1>
      <p>${escapeHtml(t.offlineBody)}</p>
      <button type="button" onclick="location.reload()">${escapeHtml(t.tryAgain)}</button>
    </section>`;
  };
  return `<!DOCTYPE html>
<html lang="en" class="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="${PWA_CANVAS_COLORS.light}">
  <title>${escapeHtml(cloud)}</title>
  <script>${themeBootstrapScript}</script>
  <style>
    html { background: ${PWA_CANVAS_COLORS.light}; color: #09090b; --secondary: #3f3f46; --solid: #1d4ed8; }
    html.dark { background: ${PWA_CANVAS_COLORS.dark}; color: #fafafa; --secondary: #e4e4e7; --solid: #2563eb; }
    html, body { height: 100%; margin: 0; }
    body {
      box-sizing: border-box; display: flex; align-items: center; justify-content: center; text-align: center;
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
      font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-text-size-adjust: 100%;
    }
    main { max-width: 22rem; padding: 2rem 1.5rem; }
    img { display: block; width: 72px; height: 72px; margin: 0 auto 0.75rem; object-fit: contain; }
    .name { margin: 0; color: var(--secondary); font-size: 0.875rem; }
    h1 { margin: 1.5rem 0 0.5rem; font-size: 1.25rem; font-weight: 650; letter-spacing: -0.02em; }
    p { margin: 0 0 1.5rem; color: var(--secondary); }
    button { min-height: 44px; padding: 0 1.25rem; border: 0; border-radius: 0.5rem; background: var(--solid); color: #fff; font: inherit; font-weight: 600; }
    [hidden] { display: none; }
  </style>
</head>
<body>
  <main>
    <img src="${escapeHtml(logo)}" alt="">
    <p class="name">${escapeHtml(cloud)}</p>
    ${section("en")}
    ${section("de")}
  </main>
  <script>
    (function () {
      var preferred = "";
      document.cookie.split(";").forEach(function (part) {
        var index = part.indexOf("=");
        if (index > 0 && part.slice(0, index).trim() === ${JSON.stringify(LOCALE_COOKIE)}) preferred = decodeURIComponent(part.slice(index + 1));
      });
      var language = (preferred || navigator.language || "en").slice(0, 2).toLowerCase() === "de" ? "de" : "en";
      document.documentElement.lang = language;
      document.querySelectorAll("section[lang]").forEach(function (section) { section.hidden = section.lang !== language; });
      document.querySelector('meta[name="theme-color"]').content =
        document.documentElement.classList.contains("dark") ? "${PWA_CANVAS_COLORS.dark}" : "${PWA_CANVAS_COLORS.light}";
    })();
  </script>
</body>
</html>`;
};

/**
 * The service worker, scope `/pwa/` (no `Service-Worker-Allowed`), with the offline page in its source. A new release,
 * installation name or logo changes the bytes, and the browser installs the new worker. Browsers check it on every
 * navigation in the app, so an unchanged worker answers `304`.
 */
export const serviceWorkerResponse = async (c: Context) => {
  const body = `const OFFLINE_HTML = ${JSON.stringify(await offlineDocument())};\n${workerSource}`;
  const etag = `"${hash(body).slice(0, 32)}"`;
  const headers = { "Cache-Control": "no-cache", ETag: etag };
  if (notModified(c, etag)) return c.body(null, 304, headers);
  return c.body(body, 200, { ...headers, "Content-Type": "text/javascript; charset=utf-8" });
};
