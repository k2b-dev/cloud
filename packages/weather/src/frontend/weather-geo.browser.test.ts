import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
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
let deleted: string | undefined;
// read through a call: after `deleted = undefined` in a test, TypeScript would narrow the variable itself
const removed = () => deleted;
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
      if (url.pathname.startsWith("/api/weather/locations/") && request.method === "DELETE") {
        deleted = url.pathname.split("/").at(-1);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/api/weather/locations" && request.method === "POST") {
        posted = await request.json();
        return Response.json({ id: "abc123" }, { status: 201 });
      }
      const asset = assets.get(url.pathname.slice(1));
      if (asset) return new Response(asset, { headers: { "Content-Type": "application/javascript" } });
      return new Response(
        `<!doctype html><html lang="de" class="${url.searchParams.has("dark") ? "dark" : "light"}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/tabler-icons.css"></head><body class="k2b-ui" style="margin:0;height:100vh"><script id="cloud-shell-data" type="application/json">{"cloudOrigin":"https://cloud.example.org"}</script><div id="app" class="k2-ui" style="display:flex;height:100%"></div><script type="module" src="/entry.js"></script></body></html>`,
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
      // the first page of a cold WebKit takes longer than the default 5 s (CI WebKit: 5.0 s timeout, the warm ones 2.6 s)
    }, 30_000);

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
        const errors = pageErrors(page);
        await page.goto(`${server.url.href}?screen=${name}`);
        await page.locator('[data-k2-part="Workspace"]').waitFor();
        const loaders = await page.locator('[data-k2-part="Loading"], [aria-busy="true"]').count();
        const outline = await describeV2Page(page);
        const layout = await measureV2Layout(page);
        if (process.env.CLOUD_WEATHER_SHOTS) {
          await page.screenshot({ path: resolve(process.env.CLOUD_WEATHER_SHOTS, `${name}-${width}.png`) });
          await Bun.write(
            resolve(process.env.CLOUD_WEATHER_SHOTS, `${name}-${width}.txt`),
            `${outline}\nelements ${await page.locator("#app *").count()}\n${JSON.stringify(layout.problems)}`,
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

// The deeds of an open place, through its menu: the wall display up to the new window, the Cloud ID to the clipboard,
// and removing it after the question. Both clipboard and window are recorded in the page, the same in every engine.
const recordDeeds = (page: Page) =>
  page.addInitScript(() => {
    const record = window as unknown as { opened: string[]; copied: unknown[] };
    record.opened = [];
    record.copied = [];
    window.open = ((url?: string | URL) => {
      record.opened.push(String(url));
      return null;
    }) as typeof window.open;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => void record.copied.push(text),
        write: async (items: ClipboardItem[]) => {
          for (const item of items) for (const type of item.types) record.copied.push(await (await item.getType(type)).text());
        },
      },
    });
  });
const recorded = (page: Page) =>
  page.evaluate(() => {
    const record = window as unknown as { opened: string[]; copied: string[] };
    return { opened: record.opened, copied: record.copied };
  });

test("the display dialog opens the wall display with the chosen size, theme and view", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await recordDeeds(page);
    await page.goto(`${server.url.href}?screen=record`);
    await page.getByRole("button", { name: "Weitere Optionen für den Ort" }).click();
    await page.getByRole("menuitem", { name: "Anzeige einrichten" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Groß", { exact: true }).click();
    await dialog.getByText("Hell", { exact: true }).click();
    await dialog.getByText("Detailliert", { exact: true }).click();
    await dialog.getByRole("button", { name: "Anzeige öffnen" }).click();
    await dialog.waitFor({ state: "hidden" });
    const opened = (await recorded(page)).opened;
    expect(opened).toHaveLength(1);
    const url = new URL(opened[0]!, "https://cloud.example.org");
    expect({ lat: url.searchParams.get("lat"), lon: url.searchParams.get("lon") }).toEqual({ lat: "48.4", lon: "10" });
    expect({ zoom: url.searchParams.get("zoom"), theme: url.searchParams.get("theme"), detail: url.searchParams.get("detail") }).toEqual({
      zoom: "3",
      theme: "light",
      detail: "true",
    });
  } finally {
    await page.close();
  }
}, 30_000);

test("the Cloud ID of a place goes to the clipboard", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await recordDeeds(page);
    await page.goto(`${server.url.href}?screen=record`);
    await page.getByRole("button", { name: "Weitere Optionen für den Ort" }).click();
    await page.getByRole("menuitem", { name: "Cloud-ID kopieren" }).click();
    await page.waitForFunction(() => (window as unknown as { copied: unknown[] }).copied.length > 0);
    expect((await recorded(page)).copied.join("\n")).toContain("ulm001");
  } finally {
    await page.close();
  }
}, 30_000);

test("a place is removed only after the question, and the page goes back to the overview", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    deleted = undefined;
    await page.goto(`${server.url.href}?screen=record`);
    await page.getByRole("button", { name: "Weitere Optionen für den Ort" }).click();
    await page.getByRole("menuitem", { name: "Ort entfernen" }).click();
    const question = page.getByRole("alertdialog").or(page.getByRole("dialog")).first();
    await question.getByText("Diesen Ort entfernen?").waitFor();
    expect(removed()).toBeUndefined();
    await question.getByRole("button", { name: "Ort entfernen" }).click();
    await page.waitForURL("**/app/weather");
    expect(removed()).toBe("ulm001");
  } finally {
    await page.close();
  }
}, 30_000);

test("a save that fails offline keeps the dialog open and says the place was not added", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    posted = undefined;
    searchFailure = false;
    await page.route("**/api/weather/locations", (route) =>
      route.request().method() === "POST" ? route.abort("internetdisconnected") : route.continue(),
    );
    await page.goto(server.url.href);
    await page.getByRole("button", { name: "Ort hinzufügen", exact: true }).filter({ visible: true }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("searchbox").or(dialog.getByRole("combobox")).first().fill("Ulm");
    await dialog.getByRole("option", { name: /Ulm/ }).click();
    await dialog.getByRole("button", { name: "Hinzufügen", exact: true }).click();
    await dialog.getByText("Der Ort konnte nicht hinzugefügt werden").waitFor();
    expect(await dialog.isVisible()).toBe(true);
    expect(posted).toBeUndefined();
  } finally {
    await page.close();
  }
}, 30_000);

test("two places of the same name read apart by their state in the sidebar", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${server.url.href}?screen=record`);
    const nav = page.locator('[data-k2-part="Nav"]').first();
    await nav.getByRole("link", { name: /Neustadt, Hessen/ }).waitFor();
    await nav.getByRole("link", { name: /Neustadt, Sachsen/ }).waitFor();
    // a name that stands alone keeps its plain words
    expect(await nav.getByRole("link", { name: /^Ulm/ }).textContent()).not.toContain("Ulm,");
  } finally {
    await page.close();
  }
}, 30_000);

// Weather v4 (review 27.11.: "das klebt hier oben", "zu sehr Wireframe-MVP"): the day has air above its warmest label
// and no label cut at the drawing's edge, its rain bars stay in the plot, the week stands on one scale in colour, the
// signs carry the colours of weather, and a missing week is one quiet line, not a hole.
for (const width of [1440, 390])
  test(`the day breathes, the week stands on one scale, and the signs carry their colours at ${width} px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      for (const name of ["record", "worst"] as const) {
        await page.goto(`${server.url.href}?screen=${name}`);
        const canvas = page.locator('[data-k2-part="Canvas"]').first();
        await canvas.locator("svg:visible").waitFor();
        await settled(page);
        const day = await canvas.evaluate((frame) => {
          const box = frame.getBoundingClientRect();
          // the server sends the wide and the phone's day; the one this width shows is measured
          const drawing = [...frame.querySelectorAll(".wx-day-wide, .wx-day-phone")].find((one) => one.getClientRects().length > 0)!;
          const labels = [...drawing.querySelectorAll("span")]
            .filter((span) => span.textContent?.trim() && !span.querySelector("span"))
            .map((span) => span.getBoundingClientRect());
          const plot = drawing.querySelector("svg")!.getBoundingClientRect();
          const bars = [...drawing.querySelectorAll("svg rect")]
            .map((rect) => rect.getBoundingClientRect())
            .filter((rect) => rect.height < 40);
          const line = drawing.querySelector('svg path[style*="stroke"]')!;
          return {
            cut: labels.filter(
              (label) => label.top < box.top || label.bottom > box.bottom || label.left < box.left || label.right > box.right,
            ).length,
            barsInPlot: bars.every((bar) => bar.left >= plot.left - 0.5 && bar.right <= plot.right + 0.5),
            stroke: getComputedStyle(line).stroke,
          };
        });
        expect({ name, cut: day.cut, barsInPlot: day.barsInPlot }).toEqual({ name, cut: 0, barsInPlot: true });
        // the line takes the colour of its degrees, not the chart's one colour
        expect(day.stroke).toContain("url(");
      }
      // the record's week: seven bars on one scale, the coldest day starting at the scale's start
      await page.goto(`${server.url.href}?screen=record`);
      await settled(page);
      // the radar's legend speaks the page's language and draws all of the radar's colours, not one red bar
      const legend = page.getByRole("img", { name: "Legende der Niederschlagsintensität" });
      expect(await legend.textContent()).toBe("LeichtMäßigStarkExtrem");
      expect(await legend.locator("div > div").count()).toBe(8);
      await page.getByText("Deutschland · DWD").waitFor({ state: "attached" });
      // the week shows once: the table on a wide screen, one line per day on the phone
      const bars = page.locator('[data-k2-part="RangeBar"]:visible');
      expect(await bars.count()).toBe(7);
      // the coldest day (So. 29., -3,4°) starts at the scale's start; its words stand beside the bar, which says nothing
      expect(
        await bars.nth(3).evaluate((track) => track.querySelector("i")!.getBoundingClientRect().left - track.getBoundingClientRect().left),
      ).toBe(0);
      expect(await bars.nth(3).getAttribute("aria-hidden")).toBe("true");
      if (width === 390) {
        // the phone (review 27.11., "busy and heavy"): a quieter day of about 160 px, and each day one line of 44 px
        const phone = await page.evaluate(() => ({
          day: [...document.querySelectorAll<HTMLElement>(".wx-day-phone > div")].map((day) => day.getBoundingClientRect().height),
          rows: [...document.querySelectorAll<HTMLElement>('.wx-week-phone [role="listitem"]')].map(
            (row) => row.getBoundingClientRect().height,
          ),
          lists: [...document.querySelectorAll<HTMLElement>('[data-k2-part="Table"], [data-k2-part="List"]')]
            .filter((list) => list.getClientRects().length > 0)
            .map((list) => list.getAttribute("aria-label")),
        }));
        expect(phone.day.length).toBe(1);
        expect(phone.day[0]!).toBeLessThanOrEqual(180);
        expect(phone.rows).toEqual([44, 44, 44, 44, 44, 44, 44]);
        // the hours' list stays; the week's table and its phone rows give way to the one-line days
        expect(phone.lists).toEqual(["Stündliche Vorhersage"]);
      }
      // a sunny day's sign is amber, a rainy one blue: data colours, not the text ink
      const colors = await page.evaluate(() => ({
        ink: getComputedStyle(document.querySelector('[data-k2-part="Table"]')!).color,
        signs: ["sun", "cloud-rain"].map(
          (name) => getComputedStyle(document.querySelector(`[data-k2-part="Table"] [data-k2-part="Icon"][data-name="${name}"]`)!).color,
        ),
      }));
      expect(colors.signs[0]).not.toBe(colors.signs[1]);
      expect(colors.signs).not.toContain(colors.ink);
      // the worst case without a week: one quiet line in its section, no empty state's hole
      await page.goto(`${server.url.href}?screen=worst`);
      const week = page.getByRole("region", { name: "7-Tage-Vorhersage" });
      await week.getByText("Keine Vorhersage").waitFor();
      // its head and one line (93 px); the empty state with its sign stood about 180 px high (v3)
      expect((await week.boundingBox())!.height).toBeLessThan(120);
    } finally {
      await page.close();
    }
  }, 30_000);
