/** Fictional local browser fixture. Never connects to a live provider or application database. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import { z } from "zod";
import type { GeoPlaceSearchInput } from "../contracts/geo";
import { mapAddress, mapFixture, mapGeoFixture, mapSuccess, mapTime } from "./map.test-fixture";
import { AiMapActionSchema, AiMapCommandSchema, type AiMapToolResult, aiMapToolResult } from "./map-contracts";
import { type AiMapContext, applyAiMap } from "./map-service";
import type { AiMapStored } from "./map-store";
export async function startMapBrowserFixture() {
  const notes = new Map<string, string>();
  const hash = (text: string) => `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;
  const fixtureDir = await mkdtemp(join(tmpdir(), "assistant-map-"));
  const ui = resolve(import.meta.dir, "../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "chat/map-widget.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "esm",
    splitting: true,
    outdir: join(fixtureDir, "build"),
    naming: { entry: "harness.js", chunk: "chunk-[hash].js" },
    plugins: [
      {
        name: "solid-assistant-map",
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
  if (!build.success) throw new AggregateError(build.logs, "Assistant map browser build failed");
  const style = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!style.success) throw new AggregateError(style.logs, "Assistant map styles failed");
  const css = await style.outputs[0]!.text();
  const uiDist = resolve(fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css")), "..");
  const fonts = (await Bun.file(join(uiDist, "plex.css")).text()).replaceAll("./fonts/", "/public/fonts/");
  const iconSource = await Bun.file(join(uiDist, "tabler.css")).text();
  const iconFont = /tabler-icons-[\w-]+\.woff2/.exec(iconSource)?.[0];
  if (!iconFont) throw new Error("Tabler preset has no font asset");
  const icons = iconSource.replace(/\.\/tabler-icons-[\w-]+\.woff2(\?[^)]*)?/, "/public/tabler-icons.woff2");
  const assets = new Map(await Promise.all(build.outputs.map(async (asset) => [basename(asset.path), await asset.arrayBuffer()] as const)));
  const states = new Map<string, AiMapStored>();
  const followups = new Map<string, AiMapToolResult[]>();
  const { createConfig } = await import("@k2b/ssr");
  Bun.plugin(createConfig({ dev: true, rootDir: fixtureDir }).plugin());
  const { renderMapFixture } = await import("./map-ssr.test-fixture");
  const calls: string[] = [];
  const commands: unknown[] = [];
  const placeSearches: GeoPlaceSearchInput[] = [];
  const geo = mapGeoFixture();
  const get = (name: string) => {
    let saved = states.get(name);
    if (saved) return saved;
    const map = mapFixture(name.startsWith("route") ? "route" : "places");
    map.conversationId = name;
    if (name.includes("unconfigured")) {
      map.availability.configured = false;
      map.groups = [];
      map.issue = { code: "GEO_NOT_CONFIGURED" };
    }
    if (name.includes("budget")) {
      const scope = name.includes("cloud") ? "cloud" : "person";
      map.availability[scope].exhausted = true;
      map.issue = { code: "GEO_BUDGET_EXHAUSTED", scope, resetsAt: map.availability[scope].resetsAt };
    }
    if (name.includes("empty")) {
      map.groups = [];
      map.lastSearch = { categories: ["museum"], near: "Ulm", title: "Museen" };
    }
    if (name.includes("loading")) {
      map.pending = true;
      map.groups = [];
    }
    if (name.includes("failure")) map.issue = { code: "GEO_PROVIDER_FAILED" };
    if (name.includes("no-route")) {
      delete map.route;
      map.issue = { code: "GEO_NO_ROUTE" };
      map.plan = {
        stops: [
          { id: "a", address: { text: "Ulm" } },
          { id: "b", address: { text: "Blaubeuren" } },
        ],
      };
    }
    if (name.includes("overrun")) map.issue = { code: "GEO_COST_OVERRUN", distanceAllowanceMeters: 500000 };
    if (name.includes("ambiguous")) {
      delete map.route;
      map.candidates = [mapAddress(), mapAddress(1), mapAddress(2)];
      map.ambiguousStopId = "b";
      map.plan = {
        stops: [
          { id: "a", address: { text: "Ulm" } },
          { id: "b", address: { text: "Blaubeuren" } },
        ],
      };
      map.issue = { code: "GEO_ADDRESS_AMBIGUOUS" };
    }
    saved = {
      map,
      retry:
        map.kind === "route"
          ? {
              type: "route",
              title: map.title,
              stops: [
                { id: "a", address: "Ulm" },
                { id: "b", address: "Blaubeuren" },
              ],
            }
          : { type: "places", search: { title: map.title, categories: ["museum"], near: "Ulm" } },
    };
    states.set(name, saved);
    return saved;
  };
  const contextFor = (name: string): AiMapContext => ({
    geo: {
      ...geo.geo,
      searchPlaces: async (input, caller) => {
        placeSearches.push(structuredClone(input));
        const result = await geo.geo.searchPlaces(input, caller);
        if (input.name === "Wasserfall" && result.ok)
          result.data.data.places.forEach((place, i) => {
            place.name = `Fiktiver Wasserfall ${i + 1}`;
          });
        return result;
      },
      availability: async () => {
        await geo.geo.availability({});
        return mapSuccess(get(name).map.availability);
      },
    },
    caller: { locale: "de" },
    now: () => new Date(mapTime),
    verifyWeb: async () => true,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/public/fonts.css") return new Response(fonts, { headers: { "content-type": "text/css; charset=utf-8" } });
      if (path === "/public/tabler-icons.css") return new Response(icons, { headers: { "content-type": "text/css; charset=utf-8" } });
      if (path === "/public/tabler-icons.woff2") return new Response(Bun.file(join(uiDist, iconFont)));
      if (/^\/public\/fonts\/[\w-]+\.woff2$/.test(path)) return new Response(Bun.file(join(uiDist, "fonts", basename(path))));
      if (path === "/styles.css") return new Response(css, { headers: { "content-type": "text/css" } });
      if (path === "/api/geo/style") {
        calls.push("style");
        return Response.json({
          version: 8,
          sources: {
            fictional: {
              type: "geojson",
              data: {
                type: "FeatureCollection",
                features: [
                  ...Array.from({ length: 8 }, (_, i) => ({
                    type: "Feature",
                    properties: {},
                    geometry: {
                      type: "LineString",
                      coordinates: [
                        [9.978 + i * 0.003, 48.39],
                        [10.012 + i * 0.003, 48.42],
                      ],
                    },
                  })),
                  ...Array.from({ length: 8 }, (_, i) => ({
                    type: "Feature",
                    properties: {},
                    geometry: {
                      type: "LineString",
                      coordinates: [
                        [9.975, 48.392 + i * 0.003],
                        [10.024, 48.388 + i * 0.003],
                      ],
                    },
                  })),
                ],
              },
            },
          },
          layers: [
            {
              id: "land",
              type: "background",
              paint: { "background-color": url.searchParams.get("theme") === "dark" ? "#252b30" : "#e8eddf" },
            },
            {
              id: "roads",
              type: "line",
              source: "fictional",
              paint: { "line-color": url.searchParams.get("theme") === "dark" ? "#58625e" : "#ffffff", "line-width": 5 },
            },
          ],
        });
      }
      if (path.startsWith("/fixtures/") && path.endsWith("/followup")) {
        const name = path.split("/")[2]!;
        const command = AiMapCommandSchema.parse(await request.json());
        const next = await applyAiMap(get(name), command, contextFor(name));
        states.set(name, next);
        const result = aiMapToolResult(next.map, false);
        followups.set(name, [...(followups.get(name) ?? []), result]);
        return Response.json(result);
      }
      if (path.startsWith("/fixtures/")) {
        const name = path.slice(10);
        if (request.method === "DELETE") states.delete(name);
        else if (request.method === "POST") states.set(name, (await request.json()) as AiMapStored);
        return Response.json(get(name));
      }
      if (path.startsWith("/api/ai/conversations/")) {
        const name = path.split("/")[4]!;
        const before = get(name);
        if (path.endsWith("/action")) {
          const input = AiMapActionSchema.parse(await request.json());
          commands.push(input.command);
          if (input.revision !== before.map.revision) return Response.json({ code: "MAP_REVISION_CONFLICT" }, { status: 409 });
          const next = await applyAiMap(before, input.command, contextFor(name));
          states.set(name, next);
          return Response.json({ map: next.map });
        }
        if (path.endsWith("/export")) {
          const { aiMapNotebookContent } = await import("./map-notebook");
          return Response.json({
            content: aiMapNotebookContent(before.map),
            revision: before.map.revision,
            ownerUserId: "fictional-owner",
          });
        }
        return Response.json({ map: before.map, canAdmin: name.includes("admin") });
      }
      if (path === "/api/capabilities/v1/queries/notebooks/notebook.list")
        return Response.json({ data: [{ id: "Book01", name: "Fiktive Reiseplanung" }] });
      const saveScenario = new URL(request.headers.get("referer") ?? "http://localhost").searchParams.get("scenario") ?? "places";
      if (path === "/api/capabilities/v1/actions/notebooks/note.create") {
        const body = z
          .object({ input: z.object({ notebookId: z.string(), content: z.string().max(200_000) }) })
          .parse(await request.json());
        commands.push(body);
        if (saveScenario.includes("unknown-save"))
          return Response.json({ code: "CAPABILITY_UNAVAILABLE", message: "Outcome unclear" }, { status: 503 });
        notes.set(saveScenario, body.input.content);
        return Response.json({ data: { id: "Note01", notebookId: "Book01" } });
      }
      if (path === "/api/capabilities/v1/queries/notebooks/note.read") {
        return Response.json({ data: { id: "Note01", notebookId: "Book01", contentHash: hash(notes.get(saveScenario) ?? "") } });
      }
      if (path === "/api/capabilities/v1/actions/notebooks/note.edit") {
        const body = z
          .object({
            input: z.object({
              noteId: z.string(),
              ifContentHash: z.string(),
              operations: z
                .array(z.object({ kind: z.literal("append"), content: z.string().max(10_000), separator: z.literal("none") }))
                .max(20),
            }),
          })
          .parse(await request.json());
        commands.push(body);
        const content = notes.get(saveScenario) ?? "";
        const beforeHash = hash(content);
        if (beforeHash !== body.input.ifContentHash)
          return Response.json({ code: "CONTENT_CONFLICT", message: "Note changed" }, { status: 409 });
        const next = content + body.input.operations.map((op) => op.content).join("");
        notes.set(saveScenario, next);
        return Response.json({ data: { beforeHash, afterHash: hash(next) } });
      }
      const asset = assets.get(path.slice(1));
      if (asset) return new Response(asset, { headers: { "content-type": "text/javascript" } });
      if (path !== "/") return new Response(null, { status: 404 });
      const name = url.searchParams.get("scenario") ?? "places";
      const map = get(name).map;
      const theme = url.searchParams.get("theme") ?? "light";
      const lang = url.searchParams.get("lang") ?? "de";
      return new Response(
        `<!doctype html><html lang="${lang}" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css"><link rel="stylesheet" href="/styles.css"><style>body{margin:0;background:var(--ui-bg);color:var(--ui-text)}.map-fixture{width:796px;max-width:calc(100% - 32px);margin:0 auto}.fixture-question{height:36px;margin:0 0 14px;padding-top:12px}.ai-turn{margin-bottom:24px}.map-fixture[data-panel=true]{width:352px;margin-left:auto;margin-right:16px}@media(max-width:599px){.map-fixture{width:358px}.fixture-question{font-size:14px}}</style></head><body class="k2b-ui"><main class="map-fixture" data-panel="${url.searchParams.get("panel") ?? "false"}"><p class="fixture-question">Zeig mir ${map.kind === "places" ? "Museen in Ulm." : "eine Tour auf der Schwäbischen Alb."}</p><div id="fixture-mount">${renderMapFixture(map, followups.get(name) ?? [], lang)}</div></main><script id="snapshot" type="application/json">${JSON.stringify({ map, followups: followups.get(name) ?? [] }).replaceAll("<", "\\u003c")}</script>${url.searchParams.has("ssr") ? "" : '<script type="module" src="/harness.js"></script>'}</body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  const stop = async () => {
    server.stop(true);
    await rm(fixtureDir, { recursive: true, force: true });
  };
  return { server, stop, calls, commands, placeSearches, states, geo, get, notes };
}
if (import.meta.main) {
  const fixture = await startMapBrowserFixture();
  console.log(fixture.server.url.href);
  process.on("SIGTERM", async () => {
    await fixture.stop();
    process.exit(0);
  });
}
