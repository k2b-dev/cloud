import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { launchBrowser } from "../../../../ui/test/browser";

type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

const ui = new URL("../../../../ui/", import.meta.url).pathname;
let browser: Browser;
let assets: Record<string, [string, string]>;

beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./feedback-chart-tooltips.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-venue-chart-tooltips-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not transform ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Venue chart tooltip harness failed");
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const css = await Promise.all(
    ["../../../../../styles.css", "../../styles/app.css"].map(async (path) => {
      const output = await Bun.build({ entrypoints: [new URL(path, import.meta.url).pathname], plugins: [tailwind] });
      if (!output.success) throw new AggregateError(output.logs, "Venue CSS build failed");
      return output.outputs[0]!.text();
    }),
  );
  assets = {
    "/harness.js": ["text/javascript; charset=utf-8", await build.outputs[0]!.text()],
    "/app.css": ["text/css", css.join("\n")],
    "/styles.css": ["text/css", readFileSync(`${ui}dist/styles.css`, "utf8")],
  };
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

const open = async (page: Page, lang: "de" | "en", search = "") => {
  await page.route("http://venue-charts.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="${lang}"><head><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`,
      });
    const asset = assets[path];
    return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
  });
  await page.goto(`http://venue-charts.test/${search}`);
  await page.locator("[data-chart-kind] [data-chart-datum]").first().waitFor({ state: "attached" });
};

const tooltipText = async (page: Page, chart: string) => {
  const selector = `${chart} [role="tooltip"]:popover-open`;
  await page.waitForFunction((selector) => !!document.querySelector(selector)?.textContent, selector);
  const text = (await page.locator(selector).textContent()) ?? "";
  expect(text).not.toMatch(/Value|Wert|X:|Y:|Datenreihe|Series/);
  return text;
};

const boxes = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-chart-kind]")].map((chart) => {
      const { x, y, width, height } = chart.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );

test("rating line and ratings bars name the day, the rating and the count on keyboard and hover", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  try {
    await open(page, "de");
    const before = await boxes(page);
    const line = '[data-chart-kind="line"]';
    await page.locator(line).focus();
    await page.keyboard.press("Home");
    let text = await tooltipText(page, line);
    expect(text).toContain("26. Sept.");
    expect(text).toContain("Durchschnittliche Bewertung: 4,3/5");
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent?.includes("27. Sept."),
      `${line} [role="tooltip"]`,
    );
    text = await tooltipText(page, line);
    expect(text).toContain("Durchschnittliche Bewertung: 3,0/5");
    await page.keyboard.press("Escape");

    const bar = '[data-chart-kind="bar"]';
    await page.locator(`${bar} .stdlib-chart-bar`).last().hover();
    text = await tooltipText(page, bar);
    expect(text).toContain("28. Sept.");
    expect(text).toContain("Bewertungen: 4");
    // Inspection draws over the plot; the charts keep their place and size.
    expect(await boxes(page)).toEqual(before);
  } finally {
    await page.close();
  }
}, 30_000);

test("a single day's point names its day and rating like the line", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  try {
    await open(page, "en", "?single");
    const point = '[data-chart-kind="scatter"]';
    await page.locator(point).focus();
    await page.keyboard.press("Home");
    const text = await tooltipText(page, point);
    expect(text).toContain("Sep 28");
    expect(text).toContain("Average rating: 5.0/5");
  } finally {
    await page.close();
  }
}, 30_000);

test("a tap on a phone opens the bar's tooltip with its day and count", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 1400 }, hasTouch: true, isMobile: true });
  try {
    await open(page, "en");
    const bar = '[data-chart-kind="bar"]';
    await page.locator(`${bar} .stdlib-chart-bar`).first().tap();
    const text = await tooltipText(page, bar);
    expect(text).toContain("Sep 26");
    expect(text).toContain("Ratings: 1");
  } finally {
    await page.close();
  }
}, 30_000);
