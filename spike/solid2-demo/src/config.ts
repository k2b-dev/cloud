import { createConfig } from "@k2b/ssr";
import { createSSRHandler, routes } from "@k2b/ssr/hono";

type PageOptions = { title?: string };

export const { config, plugin, html } = createConfig<PageOptions>({
  dev: process.env.NODE_ENV === "development",
  rootDir: `${import.meta.dir}/..`,
  componentRoots: ["src"],
  template: ({ body, scripts, title }) => `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title ?? "Spike"}</title>
    <link rel="stylesheet" href="/v2.css" />
    <link rel="stylesheet" href="/demo.css" />
  </head>
  <body>${body}${scripts}</body>
</html>`,
});

export const ssr = createSSRHandler(html);
export { routes };
