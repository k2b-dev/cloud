import { createConfig } from "@k2b/ssr";
import { createSSRHandler, routes } from "@k2b/ssr/hono";

type PageOptions = { title?: string };

export const { config, plugin, html } = createConfig<PageOptions>({
  dev: process.env.NODE_ENV === "development",
  // Islands are found under src and built to src/_ssr, next to the server entry that serves them.
  rootDir: import.meta.dir,
  template: ({ body, scripts, title }) => `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title ?? "Spike"}</title>
    <link rel="preload" href="/fonts/plex-sans-400.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="preload" href="/fonts/plex-sans-500.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="preload" href="/fonts/plex-sans-600.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="stylesheet" href="/v2.css" />
    <link rel="stylesheet" href="/demo.css" />
  </head>
  <body>${body}${scripts}</body>
</html>`,
});

export const ssr = createSSRHandler(html);
export { routes };
