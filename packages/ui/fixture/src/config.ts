import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createSSRHandler, routes } from "@k2b/ssr/hono";

type PageOptions = {
  title?: string;
  lang?: string;
};

const fixture = createConfig<PageOptions>({
  dev: process.env.NODE_ENV === "development",
  rootDir: resolve(import.meta.dir, ".."),
  template: ({ body, scripts, title, lang }) => `<!doctype html>
<html lang="${lang ?? "en"}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title ?? "@k2b/ui standalone fixture"}</title>
    <link rel="icon" href="data:,">
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body style="margin:0;background:#e5e7eb;color:#111827;font-family:Georgia,serif">
    <header id="host-shell" style="padding:12px 20px;background:#111827;color:#fff">
      Host shell outside .k2b-ui
    </header>
    ${body}
    ${scripts}
  </body>
</html>`,
});

export const { config, plugin } = fixture;
const { html } = fixture;
export const ssr = createSSRHandler(html);
export { routes };
