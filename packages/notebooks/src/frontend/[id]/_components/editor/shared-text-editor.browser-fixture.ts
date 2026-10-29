/** Builds the actual Notebook editor composition from source with fictional data. */
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserTableServer } from "../../../../../../../scripts/fixtures/notebooks-text-editor-browser";

const buildHarness = async () => {
  // Resolve from the directory: `[id]` in a filesystem path is not a URL segment.
  const ui = `${resolve(import.meta.dir, "../../../../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "shared-text-editor.browser-harness.tsx")],
    target: "browser",
    // Keep deferred Notebook extensions deferred, as in the application's island
    // build. An IIFE eagerly parses every diagram module on each test navigation.
    format: "esm",
    splitting: true,
    minify: true,
    naming: { entry: "harness.[ext]", chunk: "chunk-[hash].[ext]", asset: "asset-[hash].[ext]" },
    conditions: ["browser", "production"],
    plugins: [
      {
        name: "solid-shared-text-editor-test",
        setup(builder) {
          builder.onResolve({ filter: /^@k2b\/ui$/ }, () => ({ path: resolve(ui, "src/index.ts") }));
          builder.onResolve({ filter: /^@k2b\/ui\/text-editor$/ }, () => ({ path: resolve(ui, "src/text-editor.ts") }));
          builder.onResolve({ filter: /^@k2b\/ui\/text-editor\/model$/ }, () => ({
            path: resolve(ui, "src/text-editor/markdown-table.ts"),
          }));
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Shared editor harness build failed");
  return new Map(build.outputs.map((output) => [`/${basename(output.path)}`, output]));
};

const buildCss = async (entry: string) => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", `${resolve(import.meta.dir, "../../../../../../cloud")}/`)))
    .default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

export const startNotebookEditorFixture = async (port = 0) => {
  const tableServer = createBrowserTableServer();
  const fonts = dirname(fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css")));
  const fontCss = await Bun.file(resolve(fonts, "plex.css")).text();
  const iconCss = await Bun.file(resolve(fonts, "tabler.css")).text();
  const iconFile = /tabler-icons-[\w-]+\.woff2/.exec(iconCss)?.[0];
  if (!iconFile) throw new Error("Missing UI icon font asset");
  const scripts = await buildHarness();
  const css =
    (await buildCss(resolve(import.meta.dir, "../../../../../../../styles.css"))) +
    (await buildCss(resolve(import.meta.dir, "../../../../styles/app.css"))) +
    (await Bun.file(resolve(import.meta.dir, "../../../../../../ui/src/styles/text-editor.css")).text());
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/plex.css") return new Response(fontCss, { headers: { "content-type": "text/css" } });
      if (path === "/tabler.css") return new Response(iconCss, { headers: { "content-type": "text/css" } });
      if (path === `/${iconFile}`) return new Response(Bun.file(resolve(fonts, iconFile)));
      if (path.startsWith("/fonts/") && basename(path) === path.slice("/fonts/".length))
        return new Response(Bun.file(resolve(fonts, "fonts", basename(path))));
      if (path === "/fixture-table-action" && request.method === "POST") return tableServer.handle(request);
      const script = scripts.get(path);
      if (script) return new Response(script);
      if (path === "/styles.css") return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
      return new Response(
        '<!doctype html><html lang="en" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
          '<script>document.documentElement.className=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.lang=new URLSearchParams(location.search).get("locale")||"en";</script><link rel="stylesheet" href="/plex.css"><link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" style="margin:0">' +
          '<div id="root" style="display:flex;width:100%;height:100dvh;min-width:0"></div><script type="module" src="/harness.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  return {
    url: server.url,
    stop(force = true) {
      server.stop(force);
      tableServer.clear();
    },
  };
};
