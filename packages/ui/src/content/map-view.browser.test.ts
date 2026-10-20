import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser, Page } from "playwright";
import { createComponent, createSignal } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";
import type { Button as ButtonComponent } from "../actions/Button";
import type { MapView as MapViewComponent } from "./MapView";
import type { MapViewStyle } from "./map-view-types";

const directory = mkdtempSync(resolve(tmpdir(), "k2b-map-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: directory });
Bun.plugin(plugin());
const { MapView } = await import("./MapView");
const { MapViewFrame } = await import("./MapViewFrame");
const { Button } = await import("../actions/Button");
const dist = resolve(import.meta.dir, "../../dist");
type FixtureOptions = { stylePath: string; darkPath?: string; empty?: boolean; polar?: boolean; dateline?: boolean };
// Shared data and tree, without compiled JSX closures: SSR and the browser create the very same fixture.
function fixtureTree(
  components: {
    MapView: typeof MapViewComponent;
    Button: typeof ButtonComponent;
    createComponent: typeof createComponent;
    createSignal: typeof createSignal;
  },
  options: FixtureOptions,
) {
  const { MapView, Button, createComponent, createSignal } = components;
  const markers = options.empty
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
  const [selectedId, setSelectedId] = createSignal("one");
  const [ownLocation, setOwnLocation] = createSignal(
    options.empty || options.polar || options.dateline ? undefined : { point: { lat: 48.401, lon: 9.991 }, accuracyMeters: 20 },
  );
  return [
    createComponent(MapView, {
      height: 400,
      style: { light: options.stylePath, dark: options.darkPath ?? "/dark.json" },
      markers,
      get selectedId() {
        return selectedId();
      },
      onSelect: setSelectedId,
      infoTile: (marker) => marker.label,
      attribution: "Local fixture",
      notice: "Walking route",
      empty: "Choose a place",
      get ownLocation() {
        return ownLocation();
      },
      onLocate: () => setOwnLocation({ point: { lat: 48.401, lon: 9.991 }, accuracyMeters: 20 }),
      lines:
        options.empty || options.polar || options.dateline
          ? []
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
            ],
      areas:
        options.empty || options.polar || options.dateline
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
            ],
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
    import { MapView, Button } from ${JSON.stringify(resolve(dist, "browser/index.js"))};
    const tree = ${fixtureTree.toString()};
    const measure = ${measureFrame.toString()};
    const island = document.getElementById("island");
    const options = JSON.parse(island.dataset.options);
    island.innerHTML = "";
    window.mapDispose = render(() => tree({ MapView, Button, createComponent, createSignal }, options), island);
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
let failedStyleRequests = 0;
let failedDarkRequests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/styles.css")
      return new Response(readFileSync(resolve(dist, "styles.css")), { headers: { "Content-Type": "text/css" } });
    if (url.pathname === "/flaky.json" && ++failedStyleRequests === 1) return new Response("Style unavailable", { status: 500 });
    if (url.pathname === "/dark.json" && url.searchParams.has("fail") && ++failedDarkRequests === 1)
      return new Response("Style unavailable", { status: 500 });
    if (["/light.json", "/dark.json", "/flaky.json"].includes(url.pathname)) return Response.json(style(url.pathname === "/dark.json"));
    const asset = assets.get(url.pathname.slice(1));
    if (asset) return new Response(asset, { headers: { "Content-Type": "text/javascript" } });
    if (url.pathname !== "/") return new Response("Missing", { status: 404 });
    const options: FixtureOptions = {
      stylePath: url.searchParams.has("flaky") ? "/flaky.json" : "/light.json",
      darkPath: url.searchParams.has("darkfail") ? "/dark.json?fail" : "/dark.json",
      empty: url.searchParams.has("empty"),
      polar: url.searchParams.has("polar"),
      dateline: url.searchParams.has("dateline"),
    };
    const html = renderToString(() => fixtureTree({ MapView, Button, createComponent, createSignal }, options));
    const spacer = url.searchParams.has("spacer") ? '<div style="height:2000px"></div>' : "";
    return new Response(
      `<!doctype html><html${url.searchParams.has("motion") ? ' data-k2b-motion="reduced"' : ""}><head>
      <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css">
      <style>body{margin:0}main{width:100%;max-width:1024px;margin:auto}solid-island{display:contents}</style></head>
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
    let darkPixel: number[] = [];
    const deadline = performance.now() + 10_000;
    do {
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
