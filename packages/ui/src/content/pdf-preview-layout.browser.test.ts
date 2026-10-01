import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

// Whether the loading placeholder and the shown document fill the same box
// depends on real flex layout, so the shipped browser build renders here.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "pdf-preview-layout.fixture.ts");
const fixture = `
import { createComponent, insert, render } from "solid-js/web";
import { PdfPreview } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const pending = [];
globalThis.settlePreviews = () => {
  for (const { outcome, resolve, reject } of pending) {
    if (outcome === "ok") resolve(new Blob(["%PDF-1.4"], { type: "application/pdf" }));
    else reject(new Error("The renderer is unavailable."));
  }
};
const request = (outcome) => () => new Promise((resolve, reject) => pending.push({ outcome, resolve, reject }));
// The containers callers use: the default shell with and without a height, and the composed parts in a sized
// column, an unsized column (the Files details panel), and a plain block.
const layouts = {
  "shell sized": (outcome) => createComponent(PdfPreview, { autoLoad: true, title: "Report", class: "sized", request: request(outcome) }),
  "shell unsized": (outcome) => createComponent(PdfPreview, { autoLoad: true, title: "Report", request: request(outcome) }),
  "composed sized column": (outcome) => composed("column sized", outcome),
  "composed unsized column": (outcome) => composed("column", outcome),
  "composed block": (outcome) => composed("", outcome),
};
const composed = (className, outcome) =>
  createComponent(PdfPreview, {
    autoLoad: true,
    request: request(outcome),
    children: (parts) => {
      const box = document.createElement("div");
      box.className = className;
      insert(box, [parts.actions, parts.content]);
      return box;
    },
  });
render(
  () =>
    Object.entries(layouts).flatMap(([name, view]) =>
      ["ok", "fail"].map((outcome) => {
        const cell = document.createElement("div");
        cell.dataset.case = name + " " + outcome;
        insert(cell, view(outcome));
        return cell;
      }),
    ),
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the PDF preview fixture for the browser.");
const script = await build.outputs[0]!.text();

const viewports = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/** The viewer box of every case: the placeholder, the document, or the error state in its place. */
const viewerBoxes = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      Array.from(document.querySelectorAll<HTMLElement>("[data-case]"), (cell) => {
        const viewer = cell.querySelector(".k2b-content-pdf-preview__placeholder, .k2b-content-pdf-preview__frame")!;
        const box = viewer.getBoundingClientRect();
        const state = viewer.getAttribute("data-state") ?? viewer.tagName.toLowerCase();
        return [cell.dataset.case!, { state, box: [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100) }];
      }),
    ),
  );

describe("@k2b/ui PdfPreview viewer", () => {
  for (const [name, options] of Object.entries(viewports)) {
    test(`keeps one box from loading to the document or the error state on ${name}`, async () => {
      const page = await browser.newPage(options);
      try {
        await page.setContent(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css} .sized { height: 24rem } .column { display: flex; flex-direction: column; gap: 0.5rem }</style></head>` +
            `<body class="k2b-ui" style="margin:0"><main id="app" style="display:grid;gap:16px;padding:16px"></main></body></html>`,
        );
        await page.addScriptTag({ content: script });
        await page.locator('[data-case] [data-state="loading"]').first().waitFor();
        const loading = await viewerBoxes(page);
        expect(Object.values(loading).map(({ state }) => state)).toEqual(Array(10).fill("loading"));
        await page.evaluate(() => (globalThis as unknown as { settlePreviews: () => void }).settlePreviews());
        await page.locator('[data-case] [data-state="error"]').first().waitFor();
        const settled = await viewerBoxes(page);
        for (const [key, { state, box }] of Object.entries(settled)) {
          expect([key, state]).toEqual([key, key.endsWith(" ok") ? "iframe" : "error"]);
          expect([key, box]).toEqual([key, loading[key]!.box]);
        }
        // Sized containers hand the viewer their remaining height; unsized ones get an iframe's default height.
        expect(loading["composed sized column ok"]!.box[3]).toBeGreaterThan(300);
        expect(loading["composed unsized column ok"]!.box[3]).toBe(150);
        expect(loading["composed block ok"]!.box[3]).toBe(150);
      } finally {
        await page.close();
      }
    });
  }
});
