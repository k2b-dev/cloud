import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

const provenance = {
  provider: "geoapify",
  attribution: { text: "Geoapify · OpenStreetMap", links: ["https://www.geoapify.com/", "https://www.openstreetmap.org/copyright"] },
  computedAt: "2026-10-20T12:00:00.000Z",
};
const place = { name: "Ulm", state: "Baden-Württemberg", lat: 48.4, lon: 10, country: "DE", provenance };
const screenshots = resolve(import.meta.dir, "../../../../.local/maps-weather/screenshots");
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let posted: unknown;
let searches = 0;
let searchFailure = false;
beforeAll(async () => {
  const ui = resolve(import.meta.dir, "../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "weather-geo.browser-harness.tsx")],
    target: "browser",
    format: "esm",
    splitting: true,
    naming: { entry: "entry.js", chunk: "chunk-[hash].js" },
    plugins: [
      {
        name: "weather-geo-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^@\/api\/client$/ }, () => ({ path: resolve(import.meta.dir, "../api/client.ts") }));
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
  if (!built.success) throw new AggregateError(built.logs, "Weather fixture build failed");
  const assets = new Map(await Promise.all(built.outputs.map(async (asset) => [basename(asset.path), await asset.arrayBuffer()] as const)));
  const css = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!css.success) throw new AggregateError(css.logs, "Weather styles failed");
  const styles = await css.outputs[0]!.text();
  await mkdir(screenshots, { recursive: true });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/styles.css") return new Response(styles, { headers: { "Content-Type": "text/css" } });
      if (url.pathname === "/api/weather/geo/search") {
        searches++;
        return searchFailure
          ? Response.json({ code: "GEO_BUDGET_EXHAUSTED", message: "Heute aufgebraucht, ab 23.10.2026 wieder." }, { status: 429 })
          : Response.json([place]);
      }
      if (url.pathname === "/api/weather/locations" && request.method === "POST") {
        posted = await request.json();
        return Response.json({ id: "abc123" }, { status: 201 });
      }
      const asset = assets.get(url.pathname.slice(1));
      if (asset) return new Response(asset, { headers: { "Content-Type": "application/javascript" } });
      return new Response(
        `<!doctype html><html lang="de" class="${url.searchParams.has("dark") ? "dark" : "light"}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui"><div id="app"></div><script type="module" src="/entry.js"></script></body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
});

for (const width of [390, 768, 1440])
  test(`Weather city sources and settings fit ${width}px in light and dark`, async () => {
    for (const dark of [false, true]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      try {
        posted = undefined;
        searches = 0;
        searchFailure = false;
        await page.goto(`${server.url.href}${dark ? "?dark" : ""}`);
        expect(await page.getByRole("link", { name: "Ortssuche", exact: true }).getAttribute("href")).toBe("/admin/places-and-maps");
        await page.screenshot({ path: resolve(screenshots, `settings-${dark ? "dark" : "light"}-${width}.png`), fullPage: true });
        await page.getByRole("button", { name: "Ort hinzufügen", exact: true }).click();
        const input = page.getByRole("combobox");
        await input.fill("Ul");
        await page.waitForTimeout(300);
        expect(searches).toBe(0);
        await input.fill("Ulm");
        await page.getByRole("option", { name: /Ulm/ }).waitFor();
        expect(await page.getByRole("link", { name: "Geoapify", exact: true }).isVisible()).toBe(true);
        expect(await page.getByRole("link", { name: "OpenStreetMap", exact: true }).getAttribute("href")).toBe(
          "https://www.openstreetmap.org/copyright",
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
        await page.screenshot({ path: resolve(screenshots, `city-suggestions-${dark ? "dark" : "light"}-${width}.png`), fullPage: true });
        await input.press("ArrowDown");
        await input.press("Enter");
        await page.waitForURL("**/app/weather/abc123");
        expect(posted).toEqual({ name: place.name, state: place.state, lat: place.lat, lon: place.lon, provenance });
      } finally {
        await page.close();
      }
    }
  });

test("Weather shows budget recovery and allows cancelling without a save", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    posted = undefined;
    searchFailure = true;
    await page.goto(server.url.href);
    await page.getByRole("button", { name: "Ort hinzufügen", exact: true }).click();
    await page.getByRole("combobox").fill("Ulm");
    await page.getByText("Heute aufgebraucht, ab 23.10.2026 wieder.").waitFor();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    expect(posted).toBeUndefined();
  } finally {
    searchFailure = false;
    await page.close();
  }
});

test("clearing a search cannot save a stale suggestion during debounce", async () => {
  const page = await browser.newPage();
  try {
    posted = undefined;
    searchFailure = false;
    await page.goto(server.url.href);
    await page.getByRole("button", { name: "Ort hinzufügen", exact: true }).click();
    const input = page.getByRole("combobox");
    await input.fill("Ulm");
    await page.getByRole("option", { name: /Ulm/ }).waitFor();
    await input.fill("U");
    await input.press("ArrowDown");
    await input.press("Enter");
    expect(posted).toBeUndefined();
    expect(page.url()).toBe(server.url.href);
  } finally {
    await page.close();
  }
});
