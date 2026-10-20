import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { PWA_CANVAS_COLORS } from "../contracts/pwa";
import { themeBootstrapScript } from "../shared/theme";
import type { RuntimeContext } from "../ssr/runtime";

const root = mkdtempSync(resolve(tmpdir(), "cloud-pwa-head-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { defineApp } = await import("./define-app");

const app = defineApp({
  id: "head-probe",
  name: "Head Probe",
  icon: "ti ti-stack",
  description: "Document head probe",
  baseUrl: "http://head-probe:3000",
  routes: ["/app/head-probe"],
  pwa: {},
});

const server = new Hono<{ Variables: { runtime: RuntimeContext } }>()
  .get(
    "/app/head-probe",
    ...app.ssr((c) => {
      c.get("page").title = "Tasks";
      c.get("page").theme = "dark";
      return () => "body";
    }),
  )
  .get(
    "/pwa/head-probe",
    ...app.ssr((c) => {
      c.get("page").title = "Tasks";
      c.get("page").pwa = { name: 'Example "Cloud" & Co' };
      return () => "body";
    }),
  )
  .get("/app/theme-probe", ...app.ssr(() => () => "body"))
  .get("/pwa/head-probe/forbidden", (c) => {
    c.set("runtime", { apps: [] });
    return app.ssr.error(c, 403, { layout: "pwa" });
  });

/** Normalize the SSR version 0 used without island output. */
const stable = (html: string) => html.replace(/\/_ssr\/\d+/g, "/_ssr/*");

/** The web document as it was before app pages existed. It must never change through the app's head. */
const WEB_DOCUMENT = `<!DOCTYPE html>
<html lang="en" class="dark" data-theme-fixed>
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="view-transition" content="same-origin">
    <title>Tasks</title>
    <meta name="description" content="Cloud workspace">
    <meta name="theme-color" content="#09090b">
    <meta name="mobile-web-app-capable" content="yes">
    <link rel="icon" href="/public/head-probe/favicon.svg">
    <style data-cloud-css-layers>@layer properties, theme, base, components, utilities;</style>
    <link rel="preload" href="/public/tabler-icons.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/public/fonts/ibm-plex-sans-latin-400-normal-3b646991d30055a9.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/public/fonts/ibm-plex-sans-latin-500-normal-0717336fb31fcdcd.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/public/fonts/ibm-plex-sans-latin-600-normal-8960851d691c054e.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/public/fonts.css">
    <link rel="stylesheet" href="/public/tabler-icons.css">
    <link rel="stylesheet" href="/public/head-probe/app.css">
    <link rel="stylesheet" href="/public/global.css">
    <script>${themeBootstrapScript}</script>
  </head>
  <body class="k2b-ui" data-k2b-app-workspace-controller="global">
    body
  </body>
  <style>solid-client,solid-island{display:contents}</style>
<script type="module" data-ssr-assets="/_ssr/*">const p="/_ssr/*";document.querySelectorAll('solid-island,solid-client').forEach(e=>import(p+'/'+e.dataset.id+'.js'));</script>
${"  "}
</html>`;

const head = (html: string) => html.slice(0, html.indexOf("</head>"));

describe("document head", () => {
  test("keeps the fixed web head apart from the shared bootstrap", async () => {
    expect(stable(await (await server.request("/app/head-probe")).text())).toBe(WEB_DOCUMENT);
  });

  test("gives app pages the manifest, the Home Screen title and the canvas as status bar colour", async () => {
    for (const theme of ["light", "dark"] as const) {
      const html = head(await (await server.request("/pwa/head-probe", { headers: { Cookie: `theme=${theme}` } })).text());
      const canvas = PWA_CANVAS_COLORS[theme];
      expect(html).toContain(`<html lang="en" class="${theme}" style="background-color:${canvas}">`);
      expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
      expect(html).toContain(`<meta name="theme-color" content="${canvas}">`);
      expect(html.match(/name="theme-color"/g)).toHaveLength(1);
      expect(html).toContain('<link rel="manifest" href="/pwa/manifest.webmanifest">');
      expect(html).toContain('<link rel="apple-touch-icon" href="/branding/apple-touch-icon.png">');
      expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Example &quot;Cloud&quot; &amp; Co">');
      expect(html).not.toContain("mobile-web-app-capable");
      // `black-translucent` lays a blur band over the top edge on iOS 26.
      expect(html).not.toContain("apple-mobile-web-app-status-bar-style");
      // Fonts, styles and the theme bootstrap stay shared with the web.
      expect(html).toContain('<link rel="stylesheet" href="/public/global.css">');
      expect(html).toContain("<style data-cloud-css-layers>");
      // No cross-fade between app pages: it would swallow the next tap. Later than global.css, which turns it on.
      expect(html.indexOf("<style data-cloud-app-navigation>@view-transition{navigation:none}</style>")).toBeGreaterThan(
        html.indexOf("/public/global.css"),
      );
    }
  });

  test("leaves preference documents unfixed and reserves fixed themes for displays", async () => {
    for (const [cookie, theme] of [
      ["", "light"],
      ["theme=dark", "dark"],
      ["theme=system; color-scheme=dark", "light"],
    ] as const) {
      const html = head(await (await server.request("/app/theme-probe", { headers: { Cookie: cookie } })).text());
      expect(html).toContain(`class="${theme}"`);
      expect(html.slice(0, html.indexOf("<head>"))).not.toContain("data-theme-fixed");
      expect(html).toContain(`<script>${themeBootstrapScript}</script>`);
      const fixed = head(await (await server.request("/app/head-probe", { headers: { Cookie: cookie } })).text());
      expect(fixed).toContain('class="dark" data-theme-fixed');
    }
  });

  test("Automatic app pages paint both system canvases before stylesheets", async () => {
    const html = head(await (await server.request("/pwa/head-probe")).text());
    expect(html).toContain('<html lang="en" class="light">');
    expect(html.slice(0, html.indexOf("<head>"))).not.toContain("data-theme-fixed");
    for (const theme of ["light", "dark"] as const)
      expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: ${theme})" content="${PWA_CANVAS_COLORS[theme]}">`);
    expect(html).toContain(
      `<style data-cloud-canvas>html{background-color:${PWA_CANVAS_COLORS.light}}@media (prefers-color-scheme: dark){html{background-color:${PWA_CANVAS_COLORS.dark}}}</style>`,
    );
    expect(html.indexOf("data-cloud-canvas")).toBeLessThan(html.indexOf('rel="stylesheet"'));
  });

  test("PWA error pages preserve an explicit dark preference before SSR runs", async () => {
    const response = await server.request("/pwa/head-probe/forbidden", { headers: { Cookie: "theme=dark" } });
    expect(response.status).toBe(403);
    const html = head(await response.text());
    expect(html).toContain(`<html lang="en" class="dark" style="background-color:${PWA_CANVAS_COLORS.dark}">`);
    expect(html).toContain(`<meta name="theme-color" content="${PWA_CANVAS_COLORS.dark}">`);
    expect(html.match(/<meta name="theme-color"[^>]*>/g)).toEqual([`<meta name="theme-color" content="${PWA_CANVAS_COLORS.dark}">`]);
  });

  test("paints the app canvas in the colours of the @k2b/ui canvas token", () => {
    const css = readFileSync(resolve(import.meta.dir, "../../../ui/src/styles/index.css"), "utf8");
    const tokens = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      return css.slice(start, css.indexOf("}", start));
    };
    const value = (block: string, name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
    const light = tokens(".k2b-ui");
    const resolveToken = (raw: string | undefined) => {
      const reference = raw && /^var\((--[\w-]+)\)$/.exec(raw)?.[1];
      return reference ? value(light, reference) : raw;
    };
    expect(resolveToken(value(light, "--k2b-surface-canvas"))).toBe(PWA_CANVAS_COLORS.light);
    expect(resolveToken(value(tokens('.k2b-ui[data-theme="dark"],\n.k2b-ui.k2b-dark,\n.dark .k2b-ui'), "--k2b-surface-canvas"))).toBe(
      PWA_CANVAS_COLORS.dark,
    );
  });
});
