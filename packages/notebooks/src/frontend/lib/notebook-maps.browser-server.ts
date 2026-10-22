import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { serializeGeoDocument } from "@k2b/cloud/geo/document";
import { createConfig } from "@k2b/ssr";
import { renderNotebookBook } from "../../lib/book-renderer";
import { fictionalMap, fictionalRouteMap, mapProvenance } from "../../lib/map.test-fixture";
import { buildNotePdfHtml } from "../../service/note-pdf";
export async function createNotebookMapFixtureServer(port = 0) {
  const directory = mkdtempSync(resolve(tmpdir(), "notebook-maps-browser-"));
  const { plugin } = createConfig({ dev: true, rootDir: directory });
  Bun.plugin(plugin());
  const available = {
    configured: true,
    cloud: { exhausted: false, resetsAt: "2026-11-01T00:00:00Z" },
    person: { exhausted: false, resetsAt: "2026-10-23T00:00:00Z" },
  };
  let server: ReturnType<typeof Bun.serve>;
  let assets = new Map<string, ArrayBuffer>();
  const requests: string[] = [];

  const ui = resolve(import.meta.dir, "../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "notebook-maps.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "esm",
    splitting: true,
    outdir: directory,
    naming: { entry: "entry.js", chunk: "chunk-[hash].js" },
    plugins: [
      {
        name: "solid-notebook-maps",
        setup(builder) {
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
  if (!built.success) throw new AggregateError(built.logs, "Notebook map harness build failed");
  assets = new Map(await Promise.all(built.outputs.map(async (asset) => [basename(asset.path), await asset.arrayBuffer()] as const)));
  const { default: tailwind } = await import("bun-plugin-tailwind");
  const styles = await Promise.all(
    ["../../styles/app.css", "../../../../../styles.css"].map(async (entry) => {
      const result = await Bun.build({ entrypoints: [resolve(import.meta.dir, entry)], plugins: [tailwind] });
      if (!result.success) throw new AggregateError(result.logs, "Notebook map CSS failed");
      return result.outputs[0]!.text();
    }),
  );
  const css = ["@layer properties, theme, base, components, utilities;", ...styles].join("\n");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname === "/print") {
        const { html } = buildNotePdfHtml({
          markdown: `# Fictional map plan\n\n${serializeGeoDocument(fictionalMap())}\n\n${serializeGeoDocument(fictionalRouteMap())}`,
          notebookShortId: "Book01",
          locale: "de",
          publicOrigin: "https://cloud.example.test",
        });
        return new Response(html, { headers: { "content-type": "text/html" } });
      }
      if (url.pathname === "/") {
        const state = url.searchParams.get("state");
        const document = state === "empty" ? { ...fictionalMap(), pins: [] } : fictionalMap();
        const availability =
          state === "off"
            ? { ...available, configured: false }
            : state === "person"
              ? { ...available, person: { ...available.person, exhausted: true } }
              : state === "cloud"
                ? { ...available, cloud: { ...available.cloud, exhausted: true } }
                : available;
        const markdown = `# Wochenende in Ulm\n\nSamstag in der Innenstadt, Sonntag raus auf die Alb. Die Pins verlinken auf die Notizen dazu.\n\n## Samstag\n\n${serializeGeoDocument(document)}\n\n## Sonntag\n\n${serializeGeoDocument(fictionalRouteMap())}`;
        const fixtureMarkdown = url.searchParams.has("editor")
          ? `# Fictional editor\n\n${serializeGeoDocument(document)}\n\n${serializeGeoDocument(document)}`
          : markdown;
        const html = renderNotebookBook({
          markdown: fixtureMarkdown,
          notebookId: "Book01",
          locale: "de",
          mapState: { availability, canAdmin: url.searchParams.get("admin") === "1" },
        }).html;
        return new Response(
          `<!doctype html><html lang="de" class="${url.searchParams.get("theme") === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css} body{margin:0;font-family:var(--k2b-font-sans);color:var(--k2b-text);background:var(--k2b-surface-canvas)}.fixture{container-type:inline-size;container-name:k2b-app-area;padding:8px 0;max-width:760px;margin:auto}.fixture article{--notebook-book-inset:16px;max-width:728px;margin:auto} #saved{display:none}</style></head><body class="k2b-ui"><main class="fixture"><article class="notebook-book-content" id="notebook-book-content">${html}</article><pre id="saved"></pre><script type="application/json" id="fixture-markdown">${JSON.stringify(fixtureMarkdown).replaceAll("<", "\\u003c")}</script></main><script type="module" src="/entry.js"></script></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (/^\/ui\/(?:[a-z-]+\.css|[a-z0-9-]+\.woff2|fonts\/[a-z0-9-]+\.woff2)$/.test(url.pathname))
        return new Response(Bun.file(resolve(ui, "dist", url.pathname.slice(4))));
      if (/^\/map-view-worker(?:-[a-z0-9]+)?\.js$/.test(url.pathname))
        return new Response(Bun.file(resolve(ui, "dist/browser/content/map-view-worker.js")), {
          headers: { "content-type": "application/javascript" },
        });
      if (url.pathname === "/api/geo/style") {
        if (new URL(request.headers.get("referer") ?? request.url).searchParams.get("state") === "style-error")
          return Response.json({ code: "GEO_PROVIDER_FAILED" }, { status: 502 });
        const dark = url.searchParams.get("theme") === "dark";
        return Response.json({
          version: 8,
          sources: {
            fictional: {
              type: "geojson",
              data: {
                type: "FeatureCollection",
                features: [
                  {
                    type: "Feature",
                    properties: { kind: "water" },
                    geometry: {
                      type: "LineString",
                      coordinates: [
                        [9.974, 48.397],
                        [9.986, 48.395],
                        [9.997, 48.393],
                        [10.008, 48.389],
                      ],
                    },
                  },
                  ...Array.from({ length: 10 }, (_, index) => ({
                    type: "Feature",
                    properties: { kind: "road" },
                    geometry: {
                      type: "LineString",
                      coordinates: [
                        [9.1, 48.3 + index * 0.07],
                        [10.1, 48.4 + index * 0.07],
                      ],
                    },
                  })),
                  ...Array.from({ length: 18 }, (_, index) => ({
                    type: "Feature",
                    properties: { kind: "road" },
                    geometry: {
                      type: "LineString",
                      coordinates: [
                        [9.97 + index * 0.0025, 48.385],
                        [9.968 + index * 0.0025, 48.41],
                      ],
                    },
                  })),
                  ...Array.from({ length: 12 }, (_, index) => ({
                    type: "Feature",
                    properties: { kind: "road" },
                    geometry: {
                      type: "LineString",
                      coordinates: [
                        [9.97, 48.385 + index * 0.002],
                        [10.02, 48.389 + index * 0.002],
                      ],
                    },
                  })),
                ],
              },
            },
          },
          layers: [
            { id: "land", type: "background", paint: { "background-color": dark ? "#182324" : "#e9eeeb" } },
            {
              id: "roads",
              type: "line",
              source: "fictional",
              filter: ["==", "kind", "road"],
              paint: { "line-color": dark ? "#435052" : "#ffffff", "line-width": 5 },
            },
            {
              id: "river",
              type: "line",
              source: "fictional",
              filter: ["==", "kind", "water"],
              paint: { "line-color": dark ? "#2a5566" : "#b4d5e0", "line-width": 24 },
            },
          ],
        });
      }
      if (url.pathname.endsWith("/geo.availability")) return capability(available);
      if (url.pathname.endsWith("/address.autocomplete")) {
        const body = (await request.json()) as { input: { text: string } };
        if (body.input.text === "Fehler")
          return Response.json({ code: "GEO_PROVIDER_FAILED", message: "Provider failed", details: {} }, { status: 502 });
        return capability({
          suggestions:
            body.input.text === "Nichts"
              ? []
              : [
                  {
                    line1: body.input.text === "Lang" ? "" : "Ulmer Spatz",
                    formatted: body.input.text === "Lang" ? "A".repeat(301) : "Münsterplatz, 89073 Ulm",
                    postalCode: "89073",
                    city: "Ulm",
                    stateRegion: "",
                    countryCode: "de",
                    point: { lat: 48.3984, lon: 9.9924 },
                    confidence: 1,
                    provenance: mapProvenance,
                  },
                ],
          provenance: mapProvenance,
        });
      }
      if (url.pathname === "/api/notebooks/search")
        return Response.json({
          data: [{ note: { id: "Note01", title: "Picknick Samstag" }, snippet: null }],
          pagination: { page: 1, per_page: 20, total: 1, total_pages: 1, has_next: false },
        });
      if (url.pathname.endsWith("/block-preview"))
        return Response.json({ markdown: "# Picknick", blocks: [], diagnostics: [], headings: [{ id: "heading-picknick", line: 1 }] });
      if (url.pathname.endsWith("/route.calculate")) return capability({ route: fictionalRouteMap().route });
      const asset = assets.get(url.pathname.slice(1));
      return asset ? new Response(asset, { headers: { "content-type": "application/javascript" } }) : new Response(null, { status: 404 });
    },
  });
  return {
    server,
    requests,
    dispose: async () => {
      await server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function capability(data: unknown) {
  return Response.json({ data });
}

if (import.meta.main) {
  if (Bun.argv.includes("--help")) {
    console.log(
      "Usage: bun --no-env-file notebook-maps.browser-server.ts [--port=PORT]\nServe fictional Notebook map fixtures on 127.0.0.1. No live Geo calls or credentials.",
    );
    process.exit(0);
  }
  const argument = Bun.argv.find((value) => value.startsWith("--port="));
  const port = argument ? Number(argument.slice(7)) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
  const fixture = await createNotebookMapFixtureServer(port);
  console.log(fixture.server.url.origin);
  const close = async () => {
    await fixture.dispose();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
