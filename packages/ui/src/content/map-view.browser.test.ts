import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser, Page } from "playwright";
import { createComponent, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";
import type { Button as ButtonComponent } from "../actions/Button";
import type { MapView as MapViewComponent } from "./MapView";
import { mapStyle } from "./map-style";
import type { MapViewHandle, MapViewMarker, MapViewStyle } from "./map-view-types";

const directory = mkdtempSync(resolve(tmpdir(), "k2b-map-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: directory });
Bun.plugin(plugin());
const { MapView } = await import("./MapView");
const { MapViewFrame } = await import("./MapViewFrame");
const { Button } = await import("../actions/Button");
const dist = resolve(import.meta.dir, "../../dist");
type FixtureOptions = {
  stylePath: string;
  darkPath?: string;
  empty?: boolean;
  polar?: boolean;
  dateline?: boolean;
  nearMe?: boolean;
  tallTile?: boolean;
  growTile?: boolean;
  longCredit?: boolean;
  vector?: boolean;
};
// Shared data and tree, without compiled JSX closures: SSR and the browser create the very same fixture.
function fixtureTree(
  components: {
    MapView: typeof MapViewComponent;
    Button: typeof ButtonComponent;
    createComponent: typeof createComponent;
    createSignal: typeof createSignal;
    createStore: typeof createStore;
  },
  options: FixtureOptions,
) {
  const { MapView, Button, createComponent, createSignal, createStore } = components;
  const markers: MapViewMarker[] = options.empty
    ? []
    : options.dateline
      ? [
          { id: "west", mark: 1, label: "West", point: { lat: 0, lon: 179.998 } },
          { id: "east", mark: 2, label: "East", point: { lat: 0, lon: 179.9995 } },
        ]
      : options.polar
        ? [
            { id: "west", mark: 1, label: "West", point: { lat: 80, lon: -45 } },
            { id: "east", mark: 2, label: "East", point: { lat: 80, lon: 45 } },
          ]
        : [
            { id: "two", mark: 2, label: "Garden", point: { lat: 48.405, lon: 9.999 } },
            { id: "a", mark: "A", label: "Start", point: { lat: 48.397, lon: 9.982 } },
            { id: "one", mark: 1, label: "Museum", point: { lat: 48.398, lon: 9.992 } },
          ];
  if (options.vector) markers.push({ id: "b", mark: "B", label: "Finish", point: { lat: 48.405, lon: 9.999 } });
  if (options.nearMe) markers.push({ id: "here", mark: 3, label: "Cafe", point: { lat: 48.401, lon: 9.991 } });
  const [saved, setSaved] = createStore({ markers });
  const [hidden, setHidden] = createSignal(false);
  if (typeof window !== "undefined") window.mapClear = () => setHidden(true);
  if (typeof window !== "undefined") window.mapSetTone = () => setSaved("markers", 0, "tone", "warning");
  const [selectedId, setSelectedId] = createSignal("one");
  const [ownLocation, setOwnLocation] = createSignal(
    options.empty || options.polar || options.dateline || options.vector
      ? undefined
      : { point: { lat: 48.401, lon: 9.991 }, accuracyMeters: 20 },
  );
  return [
    createComponent(MapView, {
      height: 400,
      ref: (handle) => {
        if (typeof window !== "undefined") window.mapHandle = handle;
      },
      class: options.tallTile || options.growTile ? "tall-tile" : undefined,
      style: { light: options.stylePath, dark: options.darkPath ?? "/dark.json" },
      get markers() {
        return hidden() ? [] : saved.markers;
      },
      get selectedId() {
        return selectedId();
      },
      onSelect: setSelectedId,
      infoTile: (marker) =>
        options.tallTile ? [marker.label, "Open until 18:00", "Category", "Street 1", "example.org"].join("\n") : marker.label,
      attribution: options.longCredit ? "© OpenStreetMap contributors · © OpenMapTiles · Geoapify" : "Local fixture",
      notice: "Walking route",
      empty: "Choose a place",
      get ownLocation() {
        return hidden() ? undefined : ownLocation();
      },
      onLocate: () => setOwnLocation({ point: { lat: 48.401, lon: 9.991 }, accuracyMeters: 20 }),
      get lines() {
        return hidden()
          ? []
          : options.empty || options.polar || options.dateline
            ? []
            : options.vector
              ? [{ id: "route", polyline6: "ok|h{A_bg`Ro}@_pRotLotL" }]
              : [
                  {
                    id: "route",
                    points: [
                      { lat: 48.397, lon: 9.982 },
                      { lat: 48.398, lon: 9.992 },
                      { lat: 48.405, lon: 9.999 },
                    ],
                  },
                  {
                    id: "preview",
                    tone: "preview",
                    points: [
                      { lat: 48.398, lon: 9.992 },
                      { lat: 48.406, lon: 9.988 },
                    ],
                  },
                ];
      },
      get areas() {
        return hidden()
          ? []
          : options.empty || options.polar || options.dateline || options.vector
            ? []
            : [
                {
                  id: "area",
                  tone: "second",
                  polygon: [
                    { lat: 48.394, lon: 9.976 },
                    { lat: 48.394, lon: 10.006 },
                    { lat: 48.41, lon: 10.006 },
                    { lat: 48.41, lon: 9.976 },
                  ],
                },
              ];
      },
    }),
    ...markers.map((marker) =>
      createComponent(Button, {
        class: "host-choice",
        variant: "text",
        get "aria-pressed"() {
          return selectedId() === marker.id;
        },
        onClick: () => setSelectedId(marker.id),
        children: marker.label,
      }),
    ),
    options.growTile
      ? createComponent(Button, {
          class: "host-more",
          variant: "text",
          children: "More details",
          onClick: (event) => {
            // Late details, as a host's own widget would load them: no selection or map prop changes, only the tile's size.
            const tile = event.currentTarget.parentElement?.querySelector(".k2b-map-view__info");
            const marker = markers.find((marker) => marker.id === selectedId());
            if (tile && marker) tile.textContent = [marker.label, "Open until 18:00", "Category", "Street 1", "example.org"].join("\n");
          },
        })
      : undefined,
  ];
}
function measureFrame() {
  const box = (element: Element) => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  return {
    root: box(document.querySelector(".k2b-map-view")!),
    pins: Array.from(document.querySelectorAll(".k2b-map-view__pin"), (pin) => {
      const r = pin.getBoundingClientRect();
      return { id: pin.getAttribute("data-id"), x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }),
  };
}
declare global {
  interface Window {
    mapHandle: MapViewHandle;
    mapSetTone: () => void;
    mapClear: () => void;
    mapServerFrame: ReturnType<typeof measureFrame>;
    mapFirstFrame: ReturnType<typeof measureFrame>;
    mapDispose: () => void;
    mapNavigationMarker?: string;
    mapSavedCanvas?: HTMLCanvasElement;
    mapSavedGl?: WebGL2RenderingContext | null;
    mapDisposedContextLost?: boolean;
  }
}
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "map-view.fixture-entry.ts");
const result = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `
    import { createComponent, createSignal } from "solid-js";
    import { render } from "solid-js/web";
    import { createStore } from "solid-js/store";
    import { MapView, Button } from ${JSON.stringify(resolve(dist, "browser/index.js"))};
    const tree = ${fixtureTree.toString()};
    const measure = ${measureFrame.toString()};
    const island = document.getElementById("island");
    const options = JSON.parse(island.dataset.options);
    island.innerHTML = "";
    window.mapDispose = render(() => tree({ MapView, Button, createComponent, createSignal, createStore }, options), island);
    // settled: this synchronous first island frame is the subject of the SSR parity test.
    window.mapFirstFrame = measure();
  `,
  },
  target: "browser",
  format: "esm",
  splitting: true,
  metafile: true,
  outdir: directory,
  // The naming @k2b/ssr uses, so the worker asset lands next to the chunks as it does in an app.
  naming: { entry: "entry.js", chunk: "chunk-[hash].js" },
});
if (!result.success || !result.metafile) throw new AggregateError(result.logs, "Could not build MapView fixture");
const lazyChunks = Object.entries(result.metafile.outputs)
  .filter(([, output]) => Object.keys(output.inputs).some((path) => path.includes("/maplibre-gl/")))
  .map(([path]) => basename(path));
expect(lazyChunks.length).toBeGreaterThan(0);
const assets = new Map(
  await Promise.all(result.outputs.map(async (output) => [basename(output.path), await output.arrayBuffer()] as const)),
);
const style = (dark: boolean): MapViewStyle => ({
  version: 8,
  sources: {
    park: {
      type: "geojson",
      data: {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [9.989, 48.4],
              [9.993, 48.4],
              [9.993, 48.403],
              [9.989, 48.403],
              [9.989, 48.4],
            ],
          ],
        },
      },
    },
  },
  layers: [
    { id: "land", type: "background", paint: { "background-color": dark ? "#182838" : "#e8dcc8" } },
    { id: "park", type: "fill", source: "park", paint: { "fill-color": dark ? "#305c40" : "#a4c894" } },
  ],
});
// Tiny deterministic OpenMapTiles-schema vector fixture. Coordinates are encoded for each requested tile;
// no provider, captured production tile, network service or renderer mock participates.
const varint = (input: number): number[] => {
  const output: number[] = [];
  let n = input;
  do {
    const byte = n % 128;
    n = Math.floor(n / 128);
    output.push(byte + (n ? 128 : 0));
  } while (n);
  return output;
};
const intField = (tag: number, n: number) => [...varint(tag * 8), ...varint(n)];
const bytesField = (tag: number, data: number[]) => [...varint(tag * 8 + 2), ...varint(data.length), ...data];
const stringField = (tag: number, text: string) => bytesField(tag, Array.from(new TextEncoder().encode(text)));
const zigzag = (n: number) => (n < 0 ? -n * 2 - 1 : n * 2);
function vectorTile(z: number, x: number, y: number): Uint8Array {
  const point = (lon: number, lat: number) => [
    Math.round((((lon + 180) / 360) * 2 ** z - x) * 4096),
    Math.round((((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * 2 ** z - y) * 4096),
  ];
  const layer = (name: string, coords: number[][], properties: Record<string, string>, type: number) => {
    let px = 0,
      py = 0;
    const encoded: number[] = [];
    coords.forEach(([lon, lat], i) => {
      const [a, b] = point(lon!, lat!);
      encoded.push(i ? 10 : 9, ...varint(zigzag(a! - px)), ...varint(zigzag(b! - py)));
      px = a!;
      py = b!;
    });
    if (type === 3) encoded.push(15);
    const entries = Object.entries(properties);
    const feature = [
      ...bytesField(
        2,
        entries.flatMap((_, i) => [i, i]),
      ),
      ...intField(3, type),
      ...bytesField(4, encoded),
    ];
    return bytesField(3, [
      ...stringField(1, name),
      ...bytesField(2, feature),
      ...entries.flatMap(([key]) => stringField(3, key)),
      ...entries.flatMap(([, value]) => bytesField(4, stringField(1, value))),
      ...intField(5, 4096),
      ...intField(15, 2),
    ]);
  };
  const road = [
    [9.975, 48.4035],
    [10.01, 48.4035],
  ];
  return new Uint8Array([
    ...layer(
      "water",
      [
        [9.989, 48.4],
        [9.993, 48.4],
        [9.993, 48.402],
        [9.989, 48.402],
      ],
      {},
      3,
    ),
    ...layer("transportation", road, { class: "minor" }, 2),
    ...layer("transportation_name", road, { class: "minor", name: "Example Road" }, 2),
  ]);
}
let vectorRequests = 0;
let glyphRequests = 0;
let vectorFailure: false | number = false;
let glyphFailure = false;
let glyphCorrupt = false;
let glyphRedirect = false;
let releaseTiles: (() => void) | undefined;
let tileBarrier: Promise<void> | undefined;
let failedStyleRequests = 0;
let failedDarkRequests = 0;
let failedTileRequests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/vector.json" || url.pathname === "/vector-dark.json")
      return Response.json(
        mapStyle({
          theme: url.pathname.includes("dark") ? "dark" : "light",
          locale: "en",
          tiles: `${url.origin}/vector/{z}/{x}/{y}.pbf`,
          glyphs: `${url.origin}/glyphs/{fontstack}/{range}.pbf`,
        }),
      );
    if (url.pathname.startsWith("/vector/")) {
      vectorRequests++;
      await tileBarrier;
      if (vectorFailure) return new Response("Missing vector tile", { status: vectorFailure });
      const [z, x, y] = url.pathname.slice(8, -4).split("/").map(Number);
      return new Response(vectorTile(z!, x!, y!), { headers: { "Content-Type": "application/x-protobuf" } });
    }
    if (url.pathname.startsWith("/glyphs/") || url.pathname.startsWith("/real-glyphs/")) {
      glyphRequests++;
      if (glyphFailure) return new Response("Missing glyphs", { status: 500 });
      if (glyphCorrupt) return new Response("<html>Not a glyph file</html>");
      if (glyphRedirect && url.pathname.startsWith("/glyphs/"))
        return Response.redirect(`${url.origin}/real-glyphs/${url.pathname.slice(8)}`, 302);
      const name = decodeURIComponent(url.pathname.split("/").at(-2)!);
      const range = url.pathname.split("/").at(-1)!;
      if (name !== "IBM Plex Sans Medium" || !/^\d+-\d+\.pbf$/.test(range)) return new Response(null, { status: 404 });
      return new Response(Bun.file(resolve(import.meta.dir, "../../map-glyphs", name, range)));
    }
    if (url.pathname === "/styles.css")
      return new Response(readFileSync(resolve(dist, "styles.css")), { headers: { "Content-Type": "text/css" } });
    if (url.pathname === "/flaky.json" && ++failedStyleRequests === 1) return new Response("Style unavailable", { status: 500 });
    if (url.pathname === "/dark.json" && url.searchParams.has("fail") && ++failedDarkRequests === 1)
      return new Response("Style unavailable", { status: 500 });
    if (["/light.json", "/dark.json", "/flaky.json"].includes(url.pathname)) return Response.json(style(url.pathname === "/dark.json"));
    if (url.pathname === "/tiles.json") {
      const base = style(false) as { sources: Record<string, unknown>; layers: unknown[] };
      return Response.json({
        ...base,
        sources: { ...base.sources, broken: { type: "raster", tiles: [`${url.origin}/tile/{z}/{x}/{y}.png`], tileSize: 256 } },
        layers: [...base.layers, { id: "broken", type: "raster", source: "broken" }],
      });
    }
    if (url.pathname.startsWith("/tile/")) {
      failedTileRequests++;
      return new Response("Tile unavailable", { status: 500 });
    }
    const asset = assets.get(url.pathname.slice(1));
    if (asset) return new Response(asset, { headers: { "Content-Type": "text/javascript" } });
    if (url.pathname !== "/") return new Response("Missing", { status: 404 });
    const options: FixtureOptions = {
      stylePath: url.searchParams.has("vector")
        ? "/vector.json"
        : url.searchParams.has("flaky")
          ? "/flaky.json"
          : url.searchParams.has("tilefail")
            ? "/tiles.json"
            : "/light.json",
      darkPath: url.searchParams.has("vector") ? "/vector-dark.json" : url.searchParams.has("darkfail") ? "/dark.json?fail" : "/dark.json",
      vector: url.searchParams.has("vector"),
      empty: url.searchParams.has("empty"),
      polar: url.searchParams.has("polar"),
      dateline: url.searchParams.has("dateline"),
      nearMe: url.searchParams.has("nearMe"),
      tallTile: url.searchParams.has("tallTile"),
      growTile: url.searchParams.has("growTile"),
      longCredit: url.searchParams.has("longCredit"),
    };
    const html = renderToString(() => fixtureTree({ MapView, Button, createComponent, createSignal, createStore }, options));
    const spacer = url.searchParams.has("spacer") ? '<div style="height:2000px"></div>' : "";
    return new Response(
      `<!doctype html><html${url.searchParams.has("motion") ? ' data-k2b-motion="reduced"' : ""}><head>
      <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css">
      <style>body{margin:0}main{width:100%;max-width:1024px;margin:auto}solid-island{display:contents}.tall-tile .k2b-map-view__info{white-space:pre-line}</style></head>
      <body class="k2b-ui">${spacer}<main><solid-island id="island" data-options='${JSON.stringify(options)}'>${html}</solid-island></main>
      <script>requestAnimationFrame(() => { window.mapServerFrame = (${measureFrame.toString()})();
        const script = document.createElement('script'); script.type = 'module'; script.src = '/entry.js'; document.body.append(script); });</script>
      </body></html>`,
      {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; worker-src 'self'; connect-src 'self'; img-src 'self' data:",
        },
      },
    );
  },
});
const origin = server.url.origin;
let browser: Browser;
setDefaultTimeout(60_000);
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  await server.stop(true);
  rmSync(directory, { recursive: true, force: true });
});
const ready = async (page: Page) => {
  await page.waitForFunction(() => document.querySelector(".k2b-map-view")?.getAttribute("data-state") === "ready", undefined, {
    timeout: 20_000,
  });
  await settled(page);
};
const sameFrame = (a: ReturnType<typeof measureFrame>, b: ReturnType<typeof measureFrame>) => {
  for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(a.root[key] - b.root[key])).toBeLessThanOrEqual(1);
  expect(a.pins.map((p) => p.id)).toEqual(b.pins.map((p) => p.id));
  for (let i = 0; i < a.pins.length; i++) {
    expect(Math.abs(a.pins[i]!.x - b.pins[i]!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(a.pins[i]!.y - b.pins[i]!.y)).toBeLessThanOrEqual(1);
  }
};
for (const width of [390, 1024]) {
  test(`server, first client and ready pin centres match, including reload at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
    try {
      await page.goto(origin);
      for (let run = 0; run < 2; run++) {
        if (run) await page.reload();
        await ready(page);
        const frames = await page.evaluate(() => [window.mapServerFrame, window.mapFirstFrame]);
        sameFrame(frames[0]!, frames[1]!);
        sameFrame(frames[0]!, await page.evaluate(measureFrame));
      }
    } finally {
      await page.close();
    }
  });
  test(`fit-all keeps pins, location and SVG vertices within the padded frame at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
    try {
      // Delay the live module through an observable test gate, so the static frame can be inspected.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(
        (url) => lazyChunks.includes(basename(url.pathname)),
        async (route) => {
          await gate;
          await route.continue();
        },
      );
      try {
        await page.goto(origin, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => !!window.mapFirstFrame, undefined, { timeout: 10_000 });
        await settled(page);
        for (let phase = 0; phase < 2; phase++) {
          if (phase) {
            release();
            await ready(page);
          }
          const inside = await page.evaluate(() => {
            const root = document.querySelector(".k2b-map-view")!.getBoundingClientRect();
            const points = Array.from(document.querySelectorAll(".k2b-map-view__pin, .k2b-map-view__me"), (element) => {
              const r = element.getBoundingClientRect();
              return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
            });
            for (const path of document.querySelectorAll(".k2b-map-view__geometry path")) points.push(path.getBoundingClientRect());
            return points.every(
              (p) => p.left >= root.left + 63 && p.right <= root.right - 63 && p.top >= root.top + 63 && p.bottom <= root.bottom - 63,
            );
          });
          expect(inside).toBe(true);
          const ownPoint = await page.evaluate(() => {
            const fit = document.querySelector(".k2b-map-view__fit")!.getBoundingClientRect();
            const dot = document.querySelector(".k2b-map-view__me")!.getBoundingClientRect();
            const mercatorY = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
            const expectedX = fit.left + ((9.991 - 9.976) / (10.006 - 9.976)) * fit.width;
            const expectedY = fit.top + ((mercatorY(48.401) - mercatorY(48.41)) / (mercatorY(48.394) - mercatorY(48.41))) * fit.height;
            return Math.hypot(dot.x + dot.width / 2 - expectedX, dot.y + dot.height / 2 - expectedY);
          });
          expect(ownPoint).toBeLessThanOrEqual(1);
        }
      } finally {
        release();
      }
    } finally {
      await page.close();
    }
  });
}

test("pins never cover the own-location dot", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, reducedMotion: "reduce" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.route(
      (url) => lazyChunks.includes(basename(url.pathname)),
      async (route) => {
        await gate;
        await route.continue();
      },
    );
    await page.goto(`${origin}/?nearMe`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.mapFirstFrame, undefined, { timeout: 10_000 });
    // The dot ignores pointer events like the rest of the overlay; only this probe makes it hit-testable.
    await page.addStyleTag({ content: ".k2b-map-view__me { pointer-events: auto !important; }" });
    for (let phase = 0; phase < 2; phase++) {
      if (phase) {
        release();
        await ready(page);
      }
      await settled(page);
      const visible = await page.evaluate(() => {
        const dot = document.querySelector(".k2b-map-view__me")!;
        const r = dot.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === dot;
      });
      expect(visible).toBe(true);
    }
  } finally {
    release();
    await page.close();
  }
});

test("the info tile never covers the selected pin", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, reducedMotion: "reduce" });
  try {
    await page.goto(`${origin}/?tallTile`);
    await ready(page);
    await page.locator(".host-choice").filter({ hasText: "Start" }).click();
    await settled(page);
    const visible = await page.evaluate(() => {
      const pin = document.querySelector('.k2b-map-view__pin[data-id="a"]')!;
      const r = pin.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(".k2b-map-view__pin") === pin;
    });
    expect(visible).toBe(true);
  } finally {
    await page.close();
  }
});

test("the selected pin stays clear when the info tile grows later", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, reducedMotion: "reduce" });
  try {
    await page.goto(`${origin}/?growTile`);
    await ready(page);
    await page.locator(".host-choice").filter({ hasText: "Start" }).click();
    await settled(page);
    expect(await page.locator(".k2b-map-view__info").textContent()).toBe("Start");
    await page.locator(".host-more").click();
    await settled(page);
    expect(await page.locator(".k2b-map-view__info").textContent()).toBe("Start\nOpen until 18:00\nCategory\nStreet 1\nexample.org");
    const visible = await page.evaluate(() => {
      const pin = document.querySelector('.k2b-map-view__pin[data-id="a"]')!;
      const r = pin.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(".k2b-map-view__pin") === pin;
    });
    expect(visible).toBe(true);
  } finally {
    await page.close();
  }
});

for (const width of [320, 360]) {
  test(`a long attribution wraps before it covers the scale bar at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
    try {
      await page.goto(`${origin}/?longCredit`);
      await ready(page);
      const boxes = await page.evaluate(() =>
        [".k2b-map-view__scale", ".k2b-map-view__attribution"].map((selector) => {
          const r = document.querySelector(selector)!.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }),
      );
      const [scale, credit] = boxes as [(typeof boxes)[0], (typeof boxes)[0]];
      const apart = scale.right <= credit.left || credit.bottom <= scale.top || scale.bottom <= credit.top;
      expect(apart).toBe(true);
    } finally {
      await page.close();
    }
  });
}

test("keyboard focus on the map canvas shows the token ring inside the rounded map", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, reducedMotion: "reduce" });
  try {
    await page.goto(origin);
    await ready(page);
    await page.keyboard.press("Tab");
    await settled(page);
    const ring = await page.evaluate(() => {
      const canvas = document.querySelector(".maplibregl-canvas")!;
      return {
        focused: document.activeElement === canvas,
        outline: getComputedStyle(canvas).outlineStyle,
        ring: getComputedStyle(document.querySelector(".k2b-map-view")!, "::after").boxShadow,
      };
    });
    expect(ring.focused).toBe(true);
    expect(ring.outline).toBe("none");
    expect(ring.ring).toContain("inset");
  } finally {
    await page.close();
  }
});

test("a wide fit near the pole keeps its pins when the map loads", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, reducedMotion: "reduce" });
  try {
    await page.goto(`${origin}/?polar`);
    await ready(page);
    const frames = await page.evaluate(() => [window.mapServerFrame, window.mapFirstFrame]);
    sameFrame(frames[0]!, frames[1]!);
    sameFrame(frames[0]!, await page.evaluate(measureFrame));
  } finally {
    await page.close();
  }
});

test("pins follow the map across the antimeridian", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 800 }, reducedMotion: "reduce" });
  try {
    await page.goto(`${origin}/?dateline`);
    await ready(page);
    const before = await page.evaluate(measureFrame);
    const root = before.root;
    // Drag west by 300 px: the camera's center moves east past 180° and MapLibre wraps it to -180°.
    await page.mouse.move(root.x + root.width / 2, root.y + root.height - 80);
    await page.mouse.down();
    for (let step = 1; step <= 10; step++) await page.mouse.move(root.x + root.width / 2 - step * 30, root.y + root.height - 80);
    await page.mouse.up();
    await settled(page);
    const after = await page.evaluate(measureFrame);
    for (let i = 0; i < before.pins.length; i++) {
      expect(Math.abs(after.pins[i]!.x - (before.pins[i]!.x - 300))).toBeLessThanOrEqual(2);
      expect(Math.abs(after.pins[i]!.y - before.pins[i]!.y)).toBeLessThanOrEqual(2);
    }
  } finally {
    await page.close();
  }
});

test("pin marks keep 4.5:1 contrast for every tone, filled and outlined, in light and dark", async () => {
  const tones = ["accent", "second", "neutral", "warning"] as const;
  const markup = renderToString(() =>
    createComponent(MapViewFrame, {
      height: 300,
      markers: tones.flatMap((tone, index) => [
        { id: `${tone}-stop`, mark: String.fromCharCode(65 + index), label: tone, tone, point: { lat: 48.4, lon: 10 + index / 100 } },
        { id: `${tone}-hit`, mark: index + 1, label: tone, tone, point: { lat: 48.41, lon: 10 + index / 100 } },
      ]),
    }),
  );
  const page = await browser.newPage();
  try {
    for (const dark of [false, true]) {
      await page.setContent(
        `<!doctype html><html class="${dark ? "dark" : ""}"><head><style>${readFileSync(resolve(dist, "styles.css"), "utf8")}</style></head><body class="k2b-ui">${markup}</body></html>`,
      );
      await settled(page);
      const ratios = await page.evaluate(() => {
        const rgb = (value: string) => {
          const canvas = document.createElement("canvas").getContext("2d")!;
          canvas.fillStyle = value;
          canvas.fillRect(0, 0, 1, 1);
          return Array.from(canvas.getImageData(0, 0, 1, 1).data).slice(0, 3);
        };
        const luminance = (value: string) => {
          const [r, g, b] = rgb(value).map((channel) => {
            const c = channel / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        return Array.from(document.querySelectorAll<HTMLElement>(".k2b-map-view__pin"), (pin) => {
          const style = getComputedStyle(pin);
          const [a, b] = [luminance(style.color), luminance(style.backgroundColor)].sort((x, y) => y - x);
          return { id: pin.dataset.id, ratio: (a! + 0.05) / (b! + 0.05) };
        });
      });
      for (const { id, ratio } of ratios) expect(ratio, `${dark ? "dark" : "light"} ${id}`).toBeGreaterThanOrEqual(4.5);
    }
  } finally {
    await page.close();
  }
});

test("defers both the map chunk and same-origin worker until intersection", async () => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 700 }, reducedMotion: "reduce" });
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  try {
    await page.goto(`${origin}/?spacer`);
    await page.waitForFunction(() => !!window.mapFirstFrame, undefined, { timeout: 10_000 });
    await settled(page);
    const isLive = (url: string) => lazyChunks.includes(basename(new URL(url).pathname)) || url.includes("map-view-worker");
    expect(requested.filter(isLive)).toEqual([]);
    await page.locator(".k2b-map-view").scrollIntoViewIfNeeded();
    await ready(page);
    const liveRequests = requested.filter(isLive);
    expect(liveRequests.some((url) => url.includes("map-view-worker"))).toBe(true);
    expect(liveRequests.some((url) => lazyChunks.includes(basename(new URL(url).pathname)))).toBe(true);
    expect(liveRequests.every((url) => new URL(url).origin === origin)).toBe(true);
  } finally {
    await page.close();
  }
});

test("roving keys, native activation and the host list share selection and the live tile", async () => {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  try {
    await page.goto(origin);
    await ready(page);
    const pins = page.locator(".k2b-map-view__pin");
    await page.keyboard.press("Tab");
    // The canvas may precede the pins in the tab order. Focus the selected group entry explicitly.
    await pins.filter({ hasText: "1" }).focus();
    for (const [key, name] of [
      ["ArrowRight", "2 Garden"],
      ["End", "A Start"],
      ["Home", "1 Museum"],
    ]) {
      await page.keyboard.press(key!);
      await page.waitForFunction(
        (label) => document.querySelector('.k2b-map-view__pin[aria-pressed="true"]')?.getAttribute("aria-label") === label,
        name,
        { timeout: 5000 },
      );
      const active = page.getByRole("button", { name: name!, exact: true });
      expect(await active.getAttribute("tabindex")).toBe("0");
      expect(await active.evaluate((element) => element === document.activeElement)).toBe(true);
      const label = name!.slice(name!.indexOf(" ") + 1);
      expect(await page.locator('.host-choice[aria-pressed="true"]').textContent()).toBe(label);
      expect(await page.locator(".k2b-map-view__info").textContent()).toBe(label);
    }
    await settled(page);
    const ring = await page.getByRole("button", { name: "1 Museum", exact: true }).evaluate((element) => {
      const style = getComputedStyle(element);
      return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
    });
    expect(ring).toBe(true);
    await page.locator(".host-choice").filter({ hasText: "Garden" }).click();
    expect(await page.getByRole("button", { name: "2 Garden", exact: true }).getAttribute("aria-pressed")).toBe("true");
    const first = page.getByRole("button", { name: "1 Museum", exact: true });
    await first.focus();
    await page.keyboard.press("Enter");
    expect(await first.getAttribute("aria-pressed")).toBe("true");
    const last = page.getByRole("button", { name: "A Start", exact: true });
    await last.focus();
    await page.keyboard.press("Space");
    expect(await last.getAttribute("aria-pressed")).toBe("true");
  } finally {
    await page.close();
  }
});

for (const method of ["system", "attribute"]) {
  test(`zoom has no intermediate camera frames with ${method} reduced motion`, async () => {
    const page = await browser.newPage({ reducedMotion: method === "system" ? "reduce" : "no-preference" });
    try {
      await page.goto(`${origin}/${method === "attribute" ? "?motion" : ""}`);
      await ready(page);
      await settled(page);
      // settled: the changing camera frames are the subject; deliberately sample throughout the zoom.
      const samples = await page.evaluate(async () => {
        const fit = document.querySelector(".k2b-map-view__fit")!;
        const widths = [fit.getBoundingClientRect().width];
        const button = document.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!;
        button.click();
        const started = performance.now();
        while (performance.now() - started < 300) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          widths.push(fit.getBoundingClientRect().width);
        }
        return widths;
      });
      const initial = samples[0]!;
      expect(samples.at(-1)!).toBeCloseTo(initial * 2, 1);
      expect(samples.every((value) => Math.abs(value - initial) < 1 || Math.abs(value - initial * 2) < 1)).toBe(true);
      // MapLibre's own keyboard zoom on the canvas follows the same choice.
      await page.locator(".maplibregl-canvas").focus();
      // settled: the changing camera frames are the subject; deliberately sample throughout the zoom.
      await page.evaluate(() => {
        const fit = document.querySelector(".k2b-map-view__fit")!;
        const widths = [fit.getBoundingClientRect().width];
        const state = window as Window & { mapKeyZoom?: Promise<number[]> };
        state.mapKeyZoom = (async () => {
          const started = performance.now();
          while (performance.now() - started < 600) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            widths.push(fit.getBoundingClientRect().width);
          }
          return widths;
        })();
      });
      await page.keyboard.press("=");
      const keySamples = await page.evaluate(() => (window as Window & { mapKeyZoom?: Promise<number[]> }).mapKeyZoom!);
      const before = keySamples[0]!;
      expect(keySamples.at(-1)!).toBeCloseTo(before * 2, 1);
      expect(keySamples.every((value) => Math.abs(value - before) < 1 || Math.abs(value - before * 2) < 1)).toBe(true);
    } finally {
      await page.close();
    }
  });
}

test("theme style replaces the canvas paint without navigation", async () => {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  try {
    await page.goto(origin);
    await ready(page);
    const pixel = async () => {
      await settled(page);
      const png = await page.locator(".maplibregl-canvas").screenshot();
      return await page.evaluate(async (bytes) => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return Array.from(ctx.getImageData(canvas.width - 20, canvas.height - 50, 1, 1).data).slice(0, 3);
      }, Array.from(png));
    };
    // WebKit composites the WebGL canvas with a slightly different colour transform: allow a few levels per channel.
    const near = (actual: number[], expected: number[]) => actual.every((value, index) => Math.abs(value - expected[index]!) <= 4);
    const lightPixel = await pixel();
    expect(near(lightPixel, [232, 220, 200]), `light pixel ${lightPixel}`).toBe(true);
    const response = page.waitForResponse((response) => response.url() === `${origin}/dark.json` && response.ok(), { timeout: 10_000 });
    await page.evaluate(() => {
      window.mapNavigationMarker = "same page";
      document.documentElement.classList.add("dark");
    });
    await response;
    // Playwright's WebKit captures a WebGL canvas without a preserved drawing buffer one frame late: it shows the frame
    // before MapLibre's last one. When the map goes idle right after the colour transition, that frame is mid-fade (or
    // still light) for good. One more camera step renders another frame, so the captured one carries the settled paint.
    // The zoom keeps the sampled corner on the land layer; reduced motion makes each step a single jump.
    let darkPixel: number[] = [];
    let step = 0;
    const deadline = performance.now() + 10_000;
    do {
      await page.getByRole("button", { name: step++ % 2 ? "Zoom out" : "Zoom in" }).click();
      darkPixel = await pixel();
    } while (!near(darkPixel, [24, 40, 56]) && performance.now() < deadline);
    expect(near(darkPixel, [24, 40, 56]), `dark pixel ${darkPixel}`).toBe(true);
    expect(await page.evaluate(() => window.mapNavigationMarker)).toBe("same page");
  } finally {
    await page.close();
  }
});

test("a failed style leaves usable pins and retry fetches it a second time", async () => {
  failedStyleRequests = 0;
  const page = await browser.newPage({ reducedMotion: "reduce" });
  try {
    await page.goto(`${origin}/?flaky`);
    await page.waitForFunction(() => document.querySelector(".k2b-map-view")?.getAttribute("data-state") === "error", undefined, {
      timeout: 20_000,
    });
    expect(await page.getByRole("status").textContent()).toContain("Map image did not load. The pins stay.");
    expect(await page.locator(".k2b-map-view__pin").count()).toBe(3);
    expect(await page.getByRole("button", { name: "Try again" }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "Try again" }).click();
    await ready(page);
    expect(failedStyleRequests).toBe(2);
  } finally {
    await page.close();
  }
});

test("a theme style that fails after the map is ready shows the error and retry loads it", async () => {
  failedDarkRequests = 0;
  const page = await browser.newPage({ reducedMotion: "reduce" });
  try {
    await page.goto(`${origin}/?darkfail`);
    await ready(page);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.waitForFunction(() => document.querySelector(".k2b-map-view")?.getAttribute("data-state") === "error", undefined, {
      timeout: 20_000,
    });
    expect(await page.locator(".k2b-map-view__pin").count()).toBe(3);
    await page.getByRole("button", { name: "Try again" }).click();
    await ready(page);
    expect(failedDarkRequests).toBe(2);
  } finally {
    await page.close();
  }
});

test("map code that no longer loads offers a page reload, which recovers", async () => {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  try {
    // A page that outlived a release: its map chunk is gone from the server.
    const retired = (url: URL) => lazyChunks.includes(basename(url.pathname));
    await page.route(retired, (route) => route.fulfill({ status: 404, body: "Gone" }));
    await page.goto(origin);
    await page.waitForFunction(() => document.querySelector(".k2b-map-view")?.getAttribute("data-state") === "error", undefined, {
      timeout: 20_000,
    });
    expect(await page.locator(".k2b-map-view__pin").count()).toBe(3);
    await page.unroute(retired);
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Reload page" }).click()]);
    await ready(page);
  } finally {
    await page.close();
  }
});

test("a failing tile retains pins with a visible retry instead of reporting ready", async () => {
  failedTileRequests = 0;
  const page = await browser.newPage({ reducedMotion: "reduce" });
  try {
    await page.goto(`${origin}/?tilefail`);
    await page.waitForSelector('.k2b-map-view[data-state="error"]');
    expect(failedTileRequests).toBeGreaterThan(0);
    expect(await page.getByRole("button", { name: "Try again" }).isVisible()).toBe(true);
    expect(await page.locator(".k2b-map-view__pin").count()).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
});

test("without WebGL 2 the static frame stays with a notice and MapLibre never loads", async () => {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  try {
    // A browser with WebGL 1 only: MapLibre 6 cannot draw there.
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        return kind === "webgl2" ? null : Reflect.apply(original, this, [kind, ...rest]);
      } as typeof original;
    });
    await page.goto(origin);
    await page.waitForFunction(() => document.querySelector(".k2b-map-view")?.getAttribute("data-state") === "no-webgl", undefined, {
      timeout: 10_000,
    });
    expect(await page.getByRole("status").textContent()).toContain("This browser cannot show the map image. The pins stay.");
    expect(
      await page.evaluate(() =>
        window.mapHandle.snapshot().then(
          () => "unexpected",
          (error) => error.code,
        ),
      ),
    ).toBe("not_ready");
    expect(await page.locator(".k2b-map-view__pin").count()).toBe(3);
    expect(requests.some((url) => lazyChunks.includes(basename(new URL(url).pathname)) || url.includes("map-view-worker"))).toBe(false);
  } finally {
    await page.close();
  }
});

test("empty geometry never imports the live map", async () => {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  try {
    await page.goto(`${origin}/?empty`);
    await page.waitForFunction(() => document.querySelector(".k2b-map-view")?.getAttribute("data-state") === "empty", undefined, {
      timeout: 10_000,
    });
    expect(await page.locator(".k2b-map-view__empty").textContent()).toBe("Choose a place");
    expect(
      await page.evaluate(() =>
        window.mapHandle.snapshot().then(
          () => "unexpected",
          (error) => error.code,
        ),
      ),
    ).toBe("not_ready");
    expect(await page.locator(".k2b-map-view__fit").count()).toBe(0);
    expect(requests.some((url) => lazyChunks.includes(basename(new URL(url).pathname)) || url.includes("map-view-worker"))).toBe(false);
  } finally {
    await page.close();
  }
});

test("disposing removes the map DOM and loses its WebGL context", async () => {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  try {
    await page.goto(origin);
    await ready(page);
    await page.evaluate(() => {
      window.mapSavedCanvas = document.querySelector<HTMLCanvasElement>(".maplibregl-canvas")!;
      window.mapSavedGl = window.mapSavedCanvas.getContext("webgl2");
      window.mapDispose();
    });
    await page.waitForFunction(() => window.mapSavedGl?.isContextLost() === true, undefined, { timeout: 10_000 });
    expect(await page.locator(".maplibregl-canvas").count()).toBe(0);
    expect(await page.evaluate(() => window.mapSavedGl?.isContextLost())).toBe(true);
  } finally {
    await page.close();
  }
});

async function capturePixels(page: Page) {
  return page.evaluate(async () => {
    const result = await window.mapHandle.snapshot();
    const bitmap = await createImageBitmap(result.data);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const count = (r: number, g: number, b: number, tolerance = 0) => {
      let count = 0;
      for (let i = 0; i < rgba.length; i += 4)
        if (
          Math.abs(rgba[i]! - r) <= tolerance &&
          Math.abs(rgba[i + 1]! - g) <= tolerance &&
          Math.abs(rgba[i + 2]! - b) <= tolerance &&
          rgba[i + 3] === 255
        )
          count++;
      return count;
    };
    const colorCanvas = document.createElement("canvas");
    colorCanvas.width = colorCanvas.height = 1;
    const colorContext = colorCanvas.getContext("2d")!;
    colorContext.fillStyle = getComputedStyle(document.querySelector(".k2b-map-view__stroke")!).stroke;
    colorContext.fillRect(0, 0, 1, 1);
    const routeColor = colorContext.getImageData(0, 0, 1, 1).data;
    const routePixels = count(routeColor[0]!, routeColor[1]!, routeColor[2]!);
    const base = document.querySelector<HTMLCanvasElement>(".maplibregl-canvas")!;
    const pins = Array.from(document.querySelectorAll<HTMLElement>(".k2b-map-view__pin"), (pin) => {
      const rect = pin.getBoundingClientRect(),
        root = pin.closest(".k2b-map-view")!.getBoundingClientRect();
      const x = Math.round(rect.x + rect.width / 2 - root.x),
        y = Math.round(rect.y + rect.height / 2 - root.y);
      const pixel = (dx: number, dy: number) => Array.from(ctx.getImageData(x + dx, y + dy, 1, 1).data);
      colorContext.clearRect(0, 0, 1, 1);
      colorContext.fillStyle = getComputedStyle(pin).boxShadow.match(/(?:rgba?|color|oklch|oklab)\([^)]*\)/)![0];
      colorContext.fillRect(0, 0, 1, 1);
      const expectedRing = Array.from(colorContext.getImageData(0, 0, 1, 1).data);
      return {
        expectedRing,
        id: pin.dataset.id,
        mark: pin.textContent,
        center: pixel(0, 0),
        ring: pixel(11, 0),
        text: Array.from(ctx.getImageData(x - 6, y - 7, 12, 14).data),
      };
    });
    return {
      width: result.width,
      height: result.height,
      type: result.data.type,
      size: result.data.size,
      routePixels,
      land: count(241, 239, 233),
      water: count(207, 227, 243),
      road: count(255, 255, 255),
      label: count(82, 82, 91, 8),
      pins,
      baseWidth: base.width,
      attribution: Array.from(ctx.getImageData(canvas.width - 100, canvas.height - 18, 100, 18).data),
    };
  });
}
for (const width of [390, 1024])
  test(`complete Cloud vector basemap snapshot has real pixels, labels and overlays at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
    const external: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith(origin) && !request.url().startsWith("data:")) external.push(request.url());
    });
    try {
      await page.goto(`${origin}/?vector`);
      await ready(page);
      if (process.env.MAP_SNAPSHOT_EVIDENCE_DIR) {
        const png = await page.evaluate(async () =>
          Array.from(new Uint8Array(await (await window.mapHandle.snapshot()).data.arrayBuffer())),
        );
        await Bun.write(resolve(process.env.MAP_SNAPSHOT_EVIDENCE_DIR, `map-capture-light-${width}.png`), new Uint8Array(png));
      }
      const result = await capturePixels(page);
      expect(result.type).toBe("image/png");
      expect(result.width).toBe(width);
      expect(result.height).toBe(400);
      expect(result.baseWidth).toBe(width * 2);
      expect(result.size).toBeGreaterThan(1000);
      expect(vectorRequests).toBeGreaterThan(0);
      expect(glyphRequests).toBeGreaterThan(0);
      expect(result.land).toBeGreaterThan(10000);
      expect(result.water).toBeGreaterThan(30);
      expect(result.road).toBeGreaterThan(50);
      expect(result.label).toBeGreaterThan(20);
      expect(result.routePixels).toBeGreaterThan(100);
      expect(result.pins.map((pin) => pin.mark).sort()).toEqual(["1", "2", "A", "B"]);
      for (const pin of result.pins) {
        expect(pin.ring.slice(0, 3)).toEqual(Array.from(result.pins.find((value) => value.id === "a")!.ring.slice(0, 3)));
        const white = pin.text.filter(
          (_, index) => index % 4 === 0 && pin.text[index]! > 245 && pin.text[index + 1]! > 245 && pin.text[index + 2]! > 245,
        ).length;
        if (pin.id === "a" || pin.id === "one") expect(white).toBeGreaterThan(1);
      }
      expect(result.attribution.some((value, index) => index % 4 !== 3 && value < 150)).toBe(true);
      expect(external).toEqual([]);
      const requests = vectorRequests;
      await capturePixels(page);
      expect(vectorRequests).toBe(requests); // Capture adds no paid resource chain.
    } finally {
      await page.close();
    }
  });

test("snapshot refuses missing vector tiles and glyphs, then retries through the real renderer", async () => {
  for (const failure of ["tile", "tile-404", "glyph", "corrupt-glyph"]) {
    vectorFailure = failure === "tile" ? 500 : failure === "tile-404" ? 404 : false;
    glyphFailure = failure === "glyph";
    glyphCorrupt = failure === "corrupt-glyph";
    const page = await browser.newPage({ reducedMotion: "reduce" });
    try {
      await page.goto(`${origin}/?vector`);
      await page.waitForSelector('.k2b-map-view[data-state="error"]');
      const code = await page.evaluate(() =>
        window.mapHandle.snapshot().then(
          () => "unexpected-success",
          (error) => error.code,
        ),
      );
      expect(code).toBe("resource_failed");
      vectorFailure = false;
      glyphFailure = false;
      glyphCorrupt = false;
      await page.getByRole("button", { name: "Try again" }).click();
      await ready(page);
      expect((await capturePixels(page)).water).toBeGreaterThan(30);
    } finally {
      vectorFailure = false;
      glyphFailure = false;
      glyphCorrupt = false;
      await page.close();
    }
  }
});

test("snapshot waits for resources; abort, timeout, view change and disposal cannot produce a partial PNG", async () => {
  tileBarrier = new Promise<void>((resolve) => {
    releaseTiles = resolve;
  });
  const page = await browser.newPage({ reducedMotion: "reduce" });
  try {
    await page.goto(`${origin}/?vector`);
    await page.waitForSelector('.k2b-map-view[data-state="loading"]');
    await page.waitForFunction(() => !!document.querySelector(".maplibregl-canvas"));
    expect(
      await page.evaluate(() =>
        window.mapHandle.snapshot({ timeoutMs: 20 }).then(
          () => "unexpected",
          (error) => error.code,
        ),
      ),
    ).toBe("timed_out");
    expect(
      await page.evaluate(async () => {
        const controller = new AbortController();
        const pending = window.mapHandle.snapshot({ signal: controller.signal });
        controller.abort();
        return pending.then(
          () => "unexpected",
          (error) => error.code,
        );
      }),
    ).toBe("aborted");
    expect(
      await page.evaluate(async () => {
        const controller = new AbortController();
        const first = window.mapHandle.snapshot({ signal: controller.signal });
        const second = await window.mapHandle.snapshot().then(
          () => "unexpected",
          (error) => error.code,
        );
        controller.abort();
        await first.catch(() => {});
        return second;
      }),
    ).toBe("busy");
    releaseTiles!();
    tileBarrier = undefined;
    await ready(page);
    expect((await capturePixels(page)).water).toBeGreaterThan(30);
    expect(
      await page.evaluate(async () => {
        const pending = window.mapHandle.snapshot();
        document.querySelector<HTMLElement>(".host-choice")!.click();
        return pending.then(
          () => "unexpected",
          (error) => error.code,
        );
      }),
    ).toBe("changed");
    await page.evaluate(() => window.mapDispose());
    expect(
      await page.evaluate(() =>
        window.mapHandle.snapshot().then(
          () => "unexpected",
          (error) => error.code,
        ),
      ),
    ).toBe("disposed");
  } finally {
    releaseTiles?.();
    tileBarrier = undefined;
    await page.close();
  }
});

test("dark map snapshots preserve the basemap and actual numbered-pin ring tone", async () => {
  const page = await browser.newPage({ viewport: { width: 768, height: 800 }, reducedMotion: "reduce" });
  try {
    await page.goto(`${origin}/?vector`);
    await ready(page);
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/vector-dark.json")),
      page.evaluate(() => document.documentElement.classList.add("dark")),
    ]);
    const result = await capturePixels(page);
    for (const pin of result.pins)
      for (let channel = 0; channel < 3; channel++) expect(Math.abs(pin.ring[channel]! - pin.expectedRing[channel]!)).toBeLessThan(12);
    if (process.env.MAP_SNAPSHOT_EVIDENCE_DIR) {
      const png = await page.evaluate(async () => Array.from(new Uint8Array(await (await window.mapHandle.snapshot()).data.arrayBuffer())));
      await Bun.write(resolve(process.env.MAP_SNAPSHOT_EVIDENCE_DIR, "map-capture-dark-768.png"), new Uint8Array(png));
    }
  } finally {
    await page.close();
  }
});

test("glyph observation preserves same-origin redirect behavior", async () => {
  glyphRedirect = true;
  const page = await browser.newPage({ reducedMotion: "reduce" });
  try {
    await page.goto(`${origin}/?vector`);
    await ready(page);
    expect((await capturePixels(page)).label).toBeGreaterThan(20);
  } finally {
    glyphRedirect = false;
    await page.close();
  }
});

test("clearing geometry during fresh-frame capture rejects immediately rather than waiting for timeout", async () => {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  try {
    await page.goto(`${origin}/?vector`);
    await ready(page);
    await capturePixels(page);
    expect(
      await page.evaluate(async () => {
        const pending = window.mapHandle.snapshot({ timeoutMs: 1000 });
        // Drain the font/idle awaits while staying in the same browser task before the scheduled GPU frame.
        for (let i = 0; i < 6; i++) await Promise.resolve();
        window.mapClear();
        return pending.then(
          () => "unexpected",
          (error) => error.code,
        );
      }),
    ).toBe("changed");
  } finally {
    await page.close();
  }
});
