import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../../../ui/test/browser";

const packageCache = resolve(import.meta.dir, "../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "grids-chart-tooltips-browser-"));
const { plugin } = createConfig({
  dev: false,
  verbose: false,
  rootDir: root,
  // Exercise the production Chart island, including its serialization and mount runtime.
  componentRoots: [import.meta.dir],
});
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: ChartTooltipsFixture } = await import("./chart-tooltips.browser-fixture");
const ui = resolve(import.meta.dir, "../../../../ui/dist");
const styleEntries = [
  resolve(import.meta.dir, "../../styles/app.css"),
  resolve(import.meta.dir, "../../../../cloud/src/styles/global.css"),
];
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const builds = await Promise.all(styleEntries.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of builds) if (!build.success) throw new AggregateError(build.logs, "Could not compile the Grids stylesheets.");
  const css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(builds.map((build) => build.outputs[0]!.text()))),
  ].join("\n");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
      return new Response(
        '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
          `<link rel="stylesheet" href="/ui/plex.css"><style>${css}</style><style>solid-island{display:contents}</style></head>` +
          '<body class="k2b-ui" style="margin:0"><main class="p-4">' +
          renderToString(() => createComponent(ChartTooltipsFixture, {})) +
          '</main><script type="module">await Promise.all([...document.querySelectorAll("solid-island")].map(e=>import("/_ssr/"+e.dataset.id+".js")));' +
          'requestAnimationFrame(()=>requestAnimationFrame(()=>{document.documentElement.dataset.chartsReady="true"}))</script></body></html>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 120_000);

afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    server?.stop(true);
  }
});

const desktop = { viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" } as const;
const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" } as const;
const ready = async (page: Page) => {
  await page.waitForSelector('html[data-charts-ready="true"]');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.locator("[data-ssr-error]").count()).toBe(0);
};
const open = async (options: BrowserContextOptions = desktop) => {
  const page = await browser.newPage(options);
  try {
    await page.goto(server.url.toString());
    await ready(page);
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
};
const tooltip = async (page: Page, kind: string, title: string) => {
  const selector = `[data-chart-kind="${kind}"] [role="tooltip"]:popover-open`;
  await page.waitForFunction(({ selector, title }) => document.querySelector(selector)?.textContent?.includes(title), { selector, title });
  const text = (await page.locator(selector).textContent()) ?? "";
  expect(text).not.toMatch(/Value|Wert| X:| Y:/);
  return text;
};
const closed = (page: Page) => page.waitForFunction(() => !document.querySelector('[role="tooltip"]:popover-open'));

// Hover inside a slice's painted ring, not the hole at its bounding-box centre.
const hoverSlice = async (page: Page) => {
  const point = await page
    .locator('[data-chart-kind="donut"] [data-chart-datum]')
    .first()
    .evaluate((node) => {
      const datum: { anchor: [number, number] } = JSON.parse(node.getAttribute("data-chart-datum")!);
      const matrix = node.closest("svg")!.getScreenCTM()!;
      const point = new DOMPoint(...datum.anchor).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    });
  await page.mouse.move(point.x, point.y);
};

test("hover shows category, aggregation and formatted values; keyboard inspects both line series; donut includes share", async () => {
  const page = await open();
  try {
    await page.locator('[data-chart-kind="bar"] .stdlib-chart-bar').first().hover();
    const bar = await tooltip(page, "bar", "Neu");
    expect(bar).toContain("Umsatz");
    expect(bar).toContain("4,00 €");
    // Move away before keyboard inspection so a delayed hover update cannot dismiss it in WebKit.
    await page.mouse.move(0, 0);
    await closed(page);
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    expect(await page.locator('[data-chart-kind="bar"]').evaluate((node) => node === document.activeElement)).toBe(true);
    await page.keyboard.press("Tab");
    expect(await page.locator('[data-chart-kind="line"]').evaluate((node) => node === document.activeElement)).toBe(true);
    await page.keyboard.press("Home");
    expect(await tooltip(page, "line", "Neu")).toContain("4,00 €");
    await page.keyboard.press("ArrowRight");
    const line = await tooltip(page, "line", "In Arbeit");
    for (const text of ["Umsatz", "Kosten", "9,00 €", "5,00 €"]) expect(line).toContain(text);
    expect(line.match(/In Arbeit/g)).toHaveLength(1);
    await page.keyboard.press("End");
    expect(await tooltip(page, "line", "Erledigt")).toContain("3,00 €");
    await page.keyboard.press("Escape");
    await closed(page);
    await hoverSlice(page);
    const donut = await tooltip(page, "donut", "Neu");
    for (const text of ["Umsatz", "4,00 €", "Anteil"]) expect(donut).toContain(text);
    expect(donut).toMatch(/25\s*%/);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  } finally {
    await page.close();
  }
}, 30_000);

test("each populated chart has exactly one tab stop and an empty chart has none", async () => {
  const page = await open();
  try {
    expect(await page.locator("[data-chart-kind]").count()).toBe(3);
    await page.locator("#before").focus();
    for (const kind of ["bar", "line", "donut"]) {
      await page.keyboard.press("Tab");
      const chart = page.locator(`[data-chart-kind="${kind}"]`);
      expect(await chart.evaluate((node) => node === document.activeElement)).toBe(true);
      expect(await chart.getAttribute("tabindex")).toBe("0");
      expect(await chart.locator('a[href],button,input,select,textarea,[tabindex],[contenteditable="true"]').count()).toBe(0);
    }
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("after");
    expect(await page.locator('[data-fixture-chart="empty"] [tabindex]').count()).toBe(0);
    expect(await page.locator('[data-fixture-chart="empty"] .k2b-chart__empty').count()).toBe(1);
  } finally {
    await page.close();
  }
}, 30_000);

test("a phone tap pins a named, formatted bar tooltip and an outside tap dismisses it", async () => {
  const page = await open(phone);
  try {
    await page.locator('[data-chart-kind="bar"] .stdlib-chart-bar').first().tap();
    expect(await tooltip(page, "bar", "Neu")).toContain("4,00 €");
    await page.locator('[data-chart-kind="bar"]').dispatchEvent("pointerleave", { pointerType: "touch" });
    expect(await tooltip(page, "bar", "Neu")).toContain("4,00 €");
    await page.locator("#before").tap();
    await closed(page);
  } finally {
    await page.close();
  }
}, 30_000);

const geometry = (page: Page) =>
  page.locator("[data-fixture-chart]").evaluateAll((fixtures) =>
    fixtures.flatMap((fixture) =>
      Array.from(fixture.querySelectorAll("[data-chart-kind], svg, [data-chart-y-tick-gutter], [data-chart-category]")).map((node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { kind: fixture.getAttribute("data-fixture-chart"), tag: node.tagName, x, y, width, height };
      }),
    ),
  );

for (const options of [desktop, phone]) {
  test(`${options.viewport.width}px: mounting the real island preserves chart, SVG, gutter and category geometry`, async () => {
    const page = await browser.newPage(options);
    try {
      await page.route("**/_ssr/**", (route) => route.abort());
      await page.goto(server.url.toString());
      await page.evaluate(() => document.fonts.ready);
      expect(await page.locator("[data-chart-kind]").count()).toBe(3);
      const serverBoxes = await geometry(page);
      expect(serverBoxes.length).toBe(11); // 3 chart containers + 3 SVGs + the line chart's 2 gutters and 3 category labels.
      expect(await page.locator('html[data-charts-ready="true"]').count()).toBe(0);
      await page.unroute("**/_ssr/**");
      await page.reload();
      await ready(page);
      if (options.viewport.width === 390) await page.locator('[data-chart-kind="bar"] .stdlib-chart-bar').first().tap();
      else await page.locator('[data-chart-kind="bar"] .stdlib-chart-bar').first().hover();
      expect(await tooltip(page, "bar", "Neu")).toContain("4,00 €");
      const clientBoxes = await geometry(page);
      expect(clientBoxes.length).toBe(serverBoxes.length);
      for (const [index, before] of serverBoxes.entries()) {
        const after = clientBoxes[index]!;
        expect({ kind: after.kind, tag: after.tag }).toEqual({ kind: before.kind, tag: before.tag });
        for (const key of ["x", "y", "width", "height"] as const) {
          expect(Math.abs(after[key] - before[key])).toBeLessThanOrEqual(0.5);
        }
      }
    } finally {
      await page.close();
    }
  }, 30_000);
}
