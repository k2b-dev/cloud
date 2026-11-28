import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";

import { type SiteLocale, siteText } from "./text";

export { type SiteLocale, siteText } from "./text";

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const { config, plugin, html } = createConfig<{ locale: SiteLocale; publicUrl: string; stylesheet: string }>({
  rootDir: resolve(import.meta.dir, ".."),
  componentRoots: ["site"],
  errorFallback: "site/IslandError.tsx",
  template: ({ body, scripts, locale, publicUrl, stylesheet }) => {
    const text = siteText[locale];
    return `<!doctype html><html lang="${locale}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<script>document.documentElement.classList.toggle("dark",matchMedia("(prefers-color-scheme: dark)").matches)</script>
<meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer">
<title>${text.title} · Cloud</title><meta name="description" content="${escapeHtml(text.description)}">
<link rel="canonical" href="${escapeHtml(publicUrl)}/${locale}">
<link rel="alternate" hreflang="de" href="${escapeHtml(publicUrl)}/de"><link rel="alternate" hreflang="en" href="${escapeHtml(publicUrl)}/en">
<link rel="stylesheet" href="/assets/${escapeHtml(stylesheet)}"><link rel="icon" href="data:,">
</head><body class="k2-ui">${body}${scripts}</body></html>`;
  },
});
