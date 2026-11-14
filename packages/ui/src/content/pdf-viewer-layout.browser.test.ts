import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// Whether every state fills the same rounded area depends on real flex layout, so the shipped browser build renders here.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "pdf-viewer-layout.fixture.ts");
const fixture = `
import { createComponent, insert, render } from "solid-js/web";
import { PdfViewer } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const pending = [];
globalThis.settleViewers = () => {
  for (const { outcome, resolve, reject } of pending) {
    // Not a real PDF: pdf.js cannot draw it, so the viewer ends in its "cannot be shown here" state.
    if (outcome === "ok") resolve(new Blob(["%PDF-1.4"], { type: "application/pdf" }));
    else if (outcome === "long") reject(new Error("The template could not be rendered. ".repeat(24).trim()));
    else reject(new Error("The renderer is unavailable."));
  }
};
const request = (outcome) => () => new Promise((resolve, reject) => pending.push({ outcome, resolve, reject }));
// The containers callers use: a sized class, an unsized column (the Files details panel), and a plain block.
const hosts = { sized: "", small: "column", column: "column", block: "block" };
const cases = [
  ...Object.keys(hosts).flatMap((host) => ["ok", "fail"].map((outcome) => [host, outcome])),
  // A message taller than the unsized area, as a long renderer error can be.
  ["column", "long"],
];
render(
  () =>
    cases.map(([host, outcome]) => {
      const cell = document.createElement("div");
      cell.dataset.case = host + " " + outcome;
      cell.className = hosts[host];
      insert(cell, createComponent(PdfViewer, { autoLoad: true, open: true, title: "Report", class: host === "sized" ? "sized" : host === "small" ? "small" : undefined, request: request(outcome) }));
      return cell;
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the PDF viewer layout fixture for the browser.");
const script = await build.outputs[0]!.text();

const viewports = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type Viewer = { state: string; box: number[]; radius: string; background: string };
type Fixture = { settleViewers: () => void; viewerStates: () => Record<string, Viewer> };

const viewerStates = (): Record<string, Viewer> => {
  const rect = (element: Element) => {
    const box = element.getBoundingClientRect();
    return [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100);
  };
  return Object.fromEntries(
    Array.from(document.querySelectorAll<HTMLElement>("[data-case]"), (cell) => {
      const viewer = cell.querySelector<HTMLElement>(".k2b-pdf-viewer")!;
      const style = getComputedStyle(viewer);
      return [
        cell.dataset.case!,
        { state: viewer.dataset.state!, box: rect(viewer), radius: style.borderTopLeftRadius, background: style.backgroundColor },
      ];
    }),
  );
};

const openCases = async (options: (typeof viewports)[keyof typeof viewports]): Promise<Page> => {
  const page = await browser.newPage(options);
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css} .sized { height: 24rem } .small { height: 150px; min-height: 0 } .column { display: flex; flex-direction: column; gap: 0.5rem }</style></head>` +
      `<body class="k2b-ui" style="margin:0"><main id="app" style="display:grid;gap:16px;padding:16px"></main></body></html>`,
  );
  await page.addScriptTag({ content: `${script}\nglobalThis.viewerStates = ${viewerStates};` });
  await page.locator('[data-case] .k2b-pdf-viewer[data-state="loading"]').first().waitFor();
  return page;
};
const read = (page: Page) => page.evaluate(() => (globalThis as unknown as Fixture).viewerStates());

describe("@k2b/ui PdfViewer states", () => {
  for (const [name, options] of Object.entries(viewports)) {
    test(`keeps one rounded grey area from loading to the end state on ${name}`, async () => {
      const page = await openCases(options);
      try {
        const loading = await read(page);
        expect(Object.values(loading).map(({ state }) => state)).toEqual(Array(9).fill("loading"));
        await page.evaluate(() => (globalThis as unknown as Fixture).settleViewers());
        await page.waitForFunction(
          () => document.querySelectorAll('.k2b-pdf-viewer:is([data-state="error"], [data-state="undrawable"])').length === 9,
        );
        const settled = await read(page);
        for (const [key, { state, box, radius, background }] of Object.entries(settled)) {
          expect([key, state]).toEqual([key, key.endsWith(" ok") ? "undrawable" : "error"]);
          expect([key, box]).toEqual([key, loading[key]!.box]);
          // One ground with the surface radius for every state; no frame or second box inside.
          expect([key, radius]).toEqual([key, loading[key]!.radius]);
          expect(radius).not.toBe("0px");
          expect(background).not.toBe("rgba(0, 0, 0, 0)");
        }
        expect(await page.locator(".k2b-pdf-viewer iframe, .k2b-pdf-viewer .k2b-pdf-viewer .k2b-pdf-viewer").count()).toBe(0);
        // Sized hosts give the viewer their height; unsized ones get its 200px.
        expect(loading["sized ok"]!.box[3]).toBe(384);
        expect(loading["column ok"]!.box[3]).toBe(200);
        expect(loading["block ok"]!.box[3]).toBe(200);
        // A host that sizes it smaller wins over that default.
        expect(loading["small ok"]!.box[3]).toBe(150);
        // A long error scrolls inside that area from its top instead of overflowing above it out of reach.
        const long = await page.evaluate(() => {
          const placeholder = document.querySelector<HTMLElement>('[data-case="column long"] .k2b-pdf-viewer__placeholder')!;
          const icon = placeholder.querySelector(".k2b-placeholder__icon")!;
          return {
            overflow: placeholder.scrollHeight - placeholder.clientHeight,
            iconOffset: icon.getBoundingClientRect().top - placeholder.getBoundingClientRect().top,
          };
        });
        expect(long.overflow).toBeGreaterThan(0);
        expect(long.iconOffset).toBeGreaterThanOrEqual(0);
        // "Cannot be shown here" with its open action fits the smallest area without scrolling.
        expect(await page.locator('[data-case="block ok"] .k2b-pdf-viewer__placeholder').textContent()).toBe(
          "This PDF cannot be shown hereOpen it in a new tab or download it to view it.Open in new tab",
        );
        const fit = await page.evaluate(() => {
          const hint = document.querySelector<HTMLElement>('[data-case="block ok"] .k2b-pdf-viewer__placeholder')!;
          return { overflow: hint.scrollHeight - hint.clientHeight, page: document.documentElement.scrollWidth - window.innerWidth };
        });
        expect(fit).toEqual({ overflow: 0, page: 0 });
      } finally {
        await page.close();
      }
    });
  }
});
