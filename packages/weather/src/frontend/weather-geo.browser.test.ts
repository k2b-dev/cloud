import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { weatherScreenFixtures } from "./weather-screen.fixture";

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
  // the Tabler font, so the screenshots show the symbols
  const iconCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
  const iconCss = await Bun.file(fileURLToPath(iconCssUrl)).text();
  const fontAsset = iconCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
  if (!fontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
  const icons = { css: iconCss.replace(fontAsset, "/tabler-icons.woff2"), font: fileURLToPath(new URL(fontAsset, iconCssUrl)) };
  await mkdir(screenshots, { recursive: true });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/styles.css") return new Response(styles, { headers: { "Content-Type": "text/css" } });
      if (url.pathname === "/tabler-icons.css") return new Response(icons.css, { headers: { "Content-Type": "text/css" } });
      if (url.pathname === "/tabler-icons.woff2") return new Response(Bun.file(icons.font));
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
        `<!doctype html><html lang="de" class="${url.searchParams.has("dark") ? "dark" : "light"}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/tabler-icons.css"></head><body class="k2b-ui" style="margin:0;height:100vh"><div id="app" class="k2-ui" style="display:flex;height:100%"></div><script type="module" src="/entry.js"></script></body></html>`,
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

test("the administrator's settings link the place search", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}?settings`);
    expect(await page.getByRole("link", { name: "Ortssuche", exact: true }).getAttribute("href")).toBe("/admin/base/places");
  } finally {
    await page.close();
  }
});

for (const width of [390, 768, 1440])
  for (const dark of [false, true])
    test(`Weather city search names its sources and saves the chosen city at ${width}px in ${dark ? "dark" : "light"}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      try {
        posted = undefined;
        searches = 0;
        searchFailure = false;
        await page.goto(`${server.url.href}${dark ? "?dark" : ""}`);
        // the head's primary on wide screens, the floating main action on the phone: both say "Ort hinzufügen"
        await page.getByRole("button", { name: "Ort hinzufügen", exact: true }).filter({ visible: true }).first().click();
        const dialog = page.getByRole("dialog");
        const input = dialog.getByRole("searchbox").or(dialog.getByRole("combobox")).first();
        await input.fill("Ul");
        await page.waitForTimeout(400);
        expect(searches).toBe(0);
        await input.fill("Ulm");
        await dialog.getByRole("option", { name: /Ulm/ }).waitFor();
        for (const [name, href] of [
          ["Geoapify", "https://www.geoapify.com/"],
          ["OpenStreetMap", "https://www.openstreetmap.org/copyright"],
        ] as const) {
          const link = dialog.getByRole("link", { name, exact: true });
          expect(await link.getAttribute("href")).toBe(href);
          expect(
            await link.evaluate((element) => {
              const box = element.getBoundingClientRect();
              return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest("a") === element;
            }),
          ).toBe(true);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
        await page.screenshot({ path: resolve(screenshots, `city-suggestions-${dark ? "dark" : "light"}-${width}.png`) });
        const add = dialog.getByRole("button", { name: "Hinzufügen", exact: true });
        expect(await add.isDisabled()).toBe(true);
        await dialog.getByRole("option", { name: /Ulm/ }).click();
        await add.click();
        await page.waitForURL("**/app/weather/abc123");
        expect(posted).toEqual({ name: place.name, state: place.state, lat: place.lat, lon: place.lon, provenance });
      } finally {
        await page.close();
      }
    });

test("Weather shows why the city search failed and closes without a save", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    posted = undefined;
    searchFailure = true;
    await page.goto(server.url.href);
    await page.getByRole("button", { name: "Ort hinzufügen", exact: true }).filter({ visible: true }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("searchbox").or(dialog.getByRole("combobox")).first().fill("Ulm");
    await dialog.getByText("Heute aufgebraucht, ab 23.10.2026 wieder.").waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    expect(posted).toBeUndefined();
  } finally {
    searchFailure = false;
    await page.close();
  }
});

// Every state of the screen at the three widths: no outline problem, no layout problem, no loader in the first picture.
// CLOUD_WEATHER_SHOTS=<dir> keeps a light screenshot of each.
for (const name of Object.keys(weatherScreenFixtures))
  test(`the weather screen "${name}" holds its v2 shape at 1440, 1024 and 390 px`, async () => {
    for (const width of [1440, 1024, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.goto(`${server.url.href}?screen=${name}`);
        await page.locator('[data-k2-part="Workspace"]').waitFor();
        const loaders = await page.locator('[data-k2-part="Loading"], [aria-busy="true"]').count();
        const outline = await describeV2Page(page);
        const layout = await measureV2Layout(page);
        if (process.env.CLOUD_WEATHER_SHOTS) {
          await page.screenshot({ path: resolve(process.env.CLOUD_WEATHER_SHOTS, `${name}-${width}.png`) });
          await Bun.write(
            resolve(process.env.CLOUD_WEATHER_SHOTS, `${name}-${width}.txt`),
            `${outline}\n${JSON.stringify(layout.problems)}`,
          );
        }
        expect({ width, errors, loaders, problems: outline.includes("Problems") ? outline : null, layout: layout.problems }).toEqual({
          width,
          errors: [],
          loaders: 0,
          problems: null,
          layout: [],
        });
      } finally {
        await page.close();
      }
    }
  }, 60_000);
