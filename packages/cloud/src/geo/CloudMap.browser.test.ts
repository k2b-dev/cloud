import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../../ui/test/browser";

const directory = mkdtempSync(resolve(tmpdir(), "cloud-map-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: directory });
Bun.plugin(plugin());
const { CloudMap } = await import("./CloudMap");
const markers = [{ id: "museum", mark: 1, label: "Museum am Fluss", point: { lat: 48.4, lon: 10 } }];
const snapshot = (configured: boolean) => ({
  configured,
  cloud: { exhausted: false, resetsAt: "2026-11-01T00:00:00Z" },
  person: { exhausted: false, resetsAt: "2026-10-23T00:00:00Z" },
});
const html = (configured: boolean, locale = "de") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(CloudMap, {
          height: 280,
          markers,
          availability: snapshot(configured),
          notice: configured ? undefined : "Saved places remain available",
        });
      },
    }),
  );
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let assets = new Map<string, ArrayBuffer>();
beforeAll(async () => {
  const ui = resolve(import.meta.dir, "../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const entry = resolve(import.meta.dir, "CloudMap.fixture-entry.ts");
  const build = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `
    import { createComponent } from "solid-js";
    import { render } from "solid-js/web";
    import { LocaleProvider } from "@k2b/ui";
    import { CloudMap } from "./CloudMap";
    const root = document.querySelector('#map');
    const props = JSON.parse(root.dataset.props);
    window.serverHeight = root.getBoundingClientRect().height;
    root.innerHTML = '';
    render(() => createComponent(LocaleProvider, { locale: root.dataset.locale, get children() { return createComponent(CloudMap, props); } }), root);
    window.clientHeight = root.getBoundingClientRect().height;
  `,
    },
    target: "browser",
    format: "esm",
    splitting: true,
    outdir: directory,
    naming: { entry: "entry.js", chunk: "chunk-[hash].js" },
    plugins: [
      {
        name: "solid-cloud-map",
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
  if (!build.success) throw new AggregateError(build.logs, "CloudMap browser build failed");
  assets = new Map(await Promise.all(build.outputs.map(async (asset) => [basename(asset.path), await asset.arrayBuffer()] as const)));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") {
        const configured = url.searchParams.get("configured") !== "false";
        const locale = url.searchParams.get("locale") ?? "de";
        const props = JSON.stringify({
          height: 280,
          markers,
          availability: snapshot(configured),
          notice: configured ? undefined : "Saved places remain available",
        });
        return new Response(
          `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui"><main style="padding:16px"><div id="map" data-locale="${locale}" data-props='${props}'>${html(configured, locale)}</div></main><script type="module" src="/entry.js"></script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        );
      }
      if (url.pathname === "/styles.css")
        return new Response(Bun.file(resolve(ui, "dist/styles.css")), { headers: { "Content-Type": "text/css" } });
      if (url.pathname === "/api/geo/style")
        return Response.json({
          version: 8,
          sources: {},
          layers: [{ id: "land", type: "background", paint: { "background-color": "#f5f5f4" } }],
        });
      const asset = assets.get(url.pathname.slice(1));
      return asset ? new Response(asset, { headers: { "Content-Type": "application/javascript" } }) : new Response(null, { status: 404 });
    },
  });
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
  rmSync(directory, { recursive: true, force: true });
});

for (const width of [390, 768, 1440])
  test(`CloudMap at ${width}: SSR parity, same-origin localized style, attribution and no overflow`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      const requests: string[] = [];
      page.on("request", (request) => requests.push(request.url()));
      await page.goto(server.url.href);
      await page.waitForFunction(() => document.querySelector(".maplibregl-canvas") !== null);
      expect(
        await page.evaluate(() => {
          const value = window as typeof window & { serverHeight: number; clientHeight: number };
          return value.clientHeight - value.serverHeight;
        }),
      ).toBe(0);
      expect(requests.some((url) => url.includes("/api/geo/style?theme=light&locale=de"))).toBe(true);
      expect(requests.every((url) => url.startsWith(server.url.origin) || url.startsWith("blob:"))).toBe(true);
      expect(await page.getByRole("link", { name: "© OpenStreetMap", exact: true }).getAttribute("href")).toBe(
        "https://www.openstreetmap.org/copyright",
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await page.close();
    }
  });

test("unconfigured SSR snapshot keeps saved pins and makes no map requests", async () => {
  const page = await browser.newPage();
  try {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(`${server.url}?configured=false`);
    await page.waitForFunction(() => "clientHeight" in window);
    expect(requests.filter((url) => url.includes("/api/geo/"))).toEqual([]);
    expect(await page.locator(".k2b-map-view__pin").count()).toBe(1);
    expect(await page.locator("canvas").count()).toBe(0);
  } finally {
    await page.close();
  }
});

test("CloudMap uses the inherited French map language", async () => {
  const page = await browser.newPage();
  try {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(`${server.url.href}?locale=fr-FR`);
    await page.waitForFunction(() => document.querySelector(".maplibregl-canvas") !== null);
    expect(requests.some((url) => url.includes("locale=fr"))).toBe(true);
  } finally {
    await page.close();
  }
});

test("CloudMap preserves the host recovery notice when paid maps are disabled", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}?configured=false`);
    expect(await page.getByText("Saved places remain available").isVisible()).toBe(true);
  } finally {
    await page.close();
  }
});
