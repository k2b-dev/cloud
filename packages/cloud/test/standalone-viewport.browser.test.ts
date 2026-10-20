import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser, Page } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../ui/test/browser";

// Render the applications' actual standalone roots: no Cloud shell can constrain their height.
const root = mkdtempSync(resolve(tmpdir(), "cloud-standalone-viewport-tests-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: weatherPage } = await import("../../weather/src/frontend/display/page");
const { SimpleDisplayView, DetailDisplayView, DisplayUnavailable } = await import("../../weather/src/frontend/display/DisplayViews");
const { default: FormulaReferenceWindow } = await import("../../grids/src/frontend/_components/fields/FormulaReferenceWindow.island");
const { default: QueryReferenceWindow } = await import("../../grids/src/frontend/_components/query/QueryReferenceWindow");

const server = new Hono().get("/weather/display", ...weatherPage);
const weatherProps: Parameters<typeof SimpleDisplayView>[0] = {
  data: {
    current: {
      temperature: 12,
      icon: "rain",
      cloudCover: 75,
      windSpeed: 9,
      windGust: null,
      windDirection: 180,
      humidity: 83,
      precipitation: 1.5,
      pressure: 1013,
      visibility: 10500,
      dewPoint: 8.5,
      sunshine: 0,
      stationName: "Ulm",
      timestamp: "2026-08-28T10:00:00.000Z",
    },
    hourly: [],
    daily: [],
  },
  location: "Ulm",
  state: null,
  zoom: 1,
  now: "2026-08-28T10:00:00.000Z",
  refreshSeconds: 60,
  refreshedAt: null,
};
const componentHtml = (render: () => JSX.Element) =>
  `<!doctype html><html lang="en"><head></head><body class="k2b-ui">${renderToString(render)}</body></html>`;
const pageHtml = async (path: string, status: number) => {
  const response = await server.request(path);
  expect(response.status).toBe(status);
  return response.text();
};
const surfaces: Record<string, { html: () => string | Promise<string>; selector: string }> = {
  "Weather configuration error page": { html: () => pageHtml("/weather/display", 200), selector: "main" },
  "Weather simple display": { html: () => componentHtml(() => createComponent(SimpleDisplayView, weatherProps)), selector: "main" },
  "Weather detail display": { html: () => componentHtml(() => createComponent(DetailDisplayView, weatherProps)), selector: "main" },
  "Weather unavailable display": {
    html: () =>
      componentHtml(() =>
        createComponent(DisplayUnavailable, { message: "Unavailable", refreshSeconds: 60, refreshedAt: null, retrying: true }),
      ),
    selector: "main",
  },
  "Grids formula reference window": {
    html: () => componentHtml(() => createComponent(FormulaReferenceWindow, { tableName: "Orders", fields: [] })),
    selector: "main",
  },
  "Grids query reference window": {
    html: () =>
      componentHtml(() =>
        createComponent(QueryReferenceWindow, {
          baseId: "base-probe",
          baseName: "Orders",
          tables: [],
          fieldsByTable: {},
          viewsByTable: {},
          recordCountsByTable: {},
          documents: [],
        }),
      ),
    selector: ".k2b-app-workspace",
  },
};

let browser: Browser;
let css: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

// Chromium has no collapsing toolbar. Resolve only vh to iPad's large viewport (1370/1307 of the visible window),
// leaving dvh untouched, as in layout-viewport.browser.test.ts.
const largeViewport = (page: Page) =>
  page.evaluate(() => {
    const vh = (innerHeight * 1370) / 1307 / 100;
    const walk = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          for (const property of Array.from(rule.style)) {
            const value = rule.style.getPropertyValue(property);
            const next = value.replace(/(?<![a-z-])(-?\d*\.?\d+)vh\b/g, (_, amount: string) => `${(Number(amount) * vh).toFixed(3)}px`);
            if (next !== value) rule.style.setProperty(property, next, rule.style.getPropertyPriority(property));
          }
        }
        if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules);
  });

const viewports = {
  "iPad external display": { width: 2307, height: 1307 },
  "iPad landscape": { width: 1180, height: 820 },
  "iPad portrait": { width: 820, height: 1180 },
};

describe("standalone surfaces fit the visible window while the large viewport is taller", () => {
  for (const [name, surface] of Object.entries(surfaces)) {
    for (const [device, viewport] of Object.entries(viewports)) {
      test(`${name} on ${device}`, async () => {
        const html = new HTMLRewriter()
          .on("script", { element: (script) => void script.remove() })
          .on('link[rel="stylesheet"]', { element: (link) => void link.remove() })
          .transform(await surface.html())
          .replace("</head>", `<style>${css}</style></head>`);
        const page = await browser.newPage({ viewport });
        try {
          await page.setContent(html);
          await largeViewport(page);
          const measurements = await page.evaluate((selector) => {
            const surface = document.querySelector(selector);
            if (!surface) throw new Error(`Missing standalone surface: ${selector}`);
            return {
              documentHeight: document.scrollingElement!.scrollHeight,
              surfaceHeight: Math.round(surface.getBoundingClientRect().height),
              windowHeight: innerHeight,
            };
          }, surface.selector);
          expect(measurements.documentHeight).toBe(measurements.windowHeight);
          expect(measurements.surfaceHeight).toBe(measurements.windowHeight);
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  }
});
