import type { ThemeMode } from "@k2b/fibel";
import { type FibelSsrTemplateOptions, fibelSsrTemplate } from "@k2b/fibel/solid";
import { createConfig } from "@k2b/ssr";
import { renderFontPreloads } from "./font-assets";
import { siteUrl } from "./site-config";
import { renderSolidImportMap } from "./solid-import-map";

const solidExternals = ["solid-js", "solid-js/jsx-runtime", "solid-js/store", "solid-js/web"];

export type PageOptions = {
  title: string;
  description: string;
  path: string;
  theme: ThemeMode;
  styles?: string[];
};

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const { config, html, plugin } = createConfig<PageOptions>({
  dev: process.env.NODE_ENV !== "production",
  rootDir: import.meta.dir,
  external: solidExternals,
  template: ({ body, scripts, title, description, path, theme, styles = [] }) => {
    const canonical = siteUrl ? `${siteUrl}${path}` : path;
    const stylesheets = ["/assets/homepage.css", ...styles]
      .map((href) => `<link rel="stylesheet" href="${escapeAttribute(href)}">`)
      .join("\n    ");

    return `<!doctype html>
<html lang="en" class="${theme}" data-theme="${theme}" style="color-scheme:${theme}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="view-transition" content="same-origin">
    <meta name="theme-color" content="${theme === "dark" ? "#0e0f12" : "#ffffff"}">
    <title>${escapeAttribute(title)}</title>
    <meta name="description" content="${escapeAttribute(description)}">
    <link rel="canonical" href="${escapeAttribute(canonical)}">
    <link rel="icon" type="image/svg+xml" href="/assets/logo.svg">
    ${renderFontPreloads("/assets", true)}
    ${renderSolidImportMap("/assets")}
    ${stylesheets}
  </head>
  <body class="cloud-site cloud-standalone">
    ${body}
    ${scripts}
  </body>
</html>`;
  },
});

export const { html: fibelHtml } = createConfig<FibelSsrTemplateOptions>({
  dev: process.env.NODE_ENV !== "production",
  rootDir: import.meta.dir,
  template: fibelSsrTemplate,
});
