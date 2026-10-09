import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

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
    else if (outcome === "long") reject(new Error("The template could not be rendered. ".repeat(24).trim()));
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
const cases = [
  ...Object.keys(layouts).flatMap((name) => ["ok", "fail"].map((outcome) => [name, outcome])),
  // A message taller than the unsized box, as a long renderer error can be.
  ["composed unsized column", "long"],
];
render(
  () =>
    cases.map(([name, outcome]) => {
      const cell = document.createElement("div");
      cell.dataset.case = name + " " + outcome;
      insert(cell, layouts[name](outcome));
      return cell;
    }),
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
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type Viewer = { state: string; box: number[]; frame: { box: number[]; opacity: string } | null };
type Fixture = { settlePreviews: () => void; viewerStates: () => Record<string, Viewer> };

/** What every case shows: the placeholder on top, or the document, with its box and the frame beneath. */
const viewerStates = (): Record<string, Viewer> => {
  const rect = (element: Element) => {
    const box = element.getBoundingClientRect();
    return [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100);
  };
  return Object.fromEntries(
    Array.from(document.querySelectorAll<HTMLElement>("[data-case]"), (cell) => {
      const placeholder = cell.querySelector(".k2b-content-pdf-preview__placeholder");
      const frame = cell.querySelector(".k2b-content-pdf-preview__frame");
      const shown = placeholder ?? frame!;
      const viewer: Viewer = {
        state: placeholder?.getAttribute("data-state") ?? "document",
        box: rect(shown),
        frame: frame && { box: rect(frame), opacity: getComputedStyle(frame).opacity },
      };
      return [cell.dataset.case!, viewer];
    }),
  );
};

describe("@k2b/ui PdfPreview viewer", () => {
  for (const [name, options] of Object.entries(viewports)) {
    for (const inlineViewer of [true, false]) {
      test(`keeps one box from loading to the ${inlineViewer ? "drawn document" : "missing viewer hint"} or the error state on ${name}`, async () => {
        const page = await browser.newPage(options);
        try {
          await page.setContent(
            `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css} .sized { height: 24rem } .column { display: flex; flex-direction: column; gap: 0.5rem }</style></head>` +
              `<body class="k2b-ui" style="margin:0"><main id="app" style="display:grid;gap:16px;padding:16px"></main></body></html>`,
          );
          await page.evaluate((enabled) => {
            Object.defineProperty(Navigator.prototype, "pdfViewerEnabled", { configurable: true, get: () => enabled });
          }, inlineViewer);
          await page.addScriptTag({ content: `${script}\nglobalThis.viewerStates = ${viewerStates};` });
          await page.locator('[data-case] [data-state="loading"]').first().waitFor();
          const read = () => page.evaluate(() => (globalThis as unknown as Fixture).viewerStates());
          const loading = await read();
          expect(Object.values(loading).map(({ state }) => state)).toEqual(Array(11).fill("loading"));
          // The documents arrive in microtasks of one task, and a frame fires `load` only in a later task: the observer
          // sees every frame before any has drawn its document.
          const arrived = await page.evaluate(
            () =>
              new Promise<Record<string, Viewer> | null>((resolve) => {
                const fixture = globalThis as unknown as Fixture;
                if (!navigator.pdfViewerEnabled) {
                  fixture.settlePreviews();
                  return resolve(null);
                }
                new MutationObserver((_records, observer) => {
                  if (document.querySelectorAll(".k2b-content-pdf-preview__frame").length < 5) return;
                  observer.disconnect();
                  resolve(fixture.viewerStates());
                }).observe(document.getElementById("app")!, { childList: true, subtree: true });
                fixture.settlePreviews();
              }),
          );
          await page.locator('[data-case] [data-state="error"]').first().waitFor();
          // Neither engine draws a PDF in a frame (Chromium's headless shell has no viewer, Playwright's WebKit never
          // loads one), so the frames report their drawn document here.
          await page.evaluate(() => {
            for (const frame of document.querySelectorAll(".k2b-content-pdf-preview__frame")) frame.dispatchEvent(new Event("load"));
          });
          const settled = await read();
          for (const [key, { state, box, frame }] of Object.entries(settled)) {
            const ok = key.endsWith(" ok");
            expect([key, state]).toEqual([key, ok ? (inlineViewer ? "document" : "empty") : "error"]);
            expect([key, box]).toEqual([key, loading[key]!.box]);
            expect([key, frame]).toEqual([key, ok && inlineViewer ? { box, opacity: "1" } : null]);
            // Until it has drawn the document, the frame lies transparent beneath the loading state in the same box.
            if (ok && inlineViewer) expect([key, arrived?.[key]]).toEqual([key, { state: "loading", box, frame: { box, opacity: "0" } }]);
          }
          if (!inlineViewer) {
            expect(await page.locator('[data-case="shell sized ok"] .k2b-content-pdf-preview__placeholder').textContent()).toBe(
              "This PDF cannot be shown hereYour browser cannot show PDFs inside a page. Open or download the document to view it.",
            );
          }
          // Sized containers hand the viewer their remaining height; unsized ones get an iframe's default height.
          expect(loading["composed sized column ok"]!.box[3]).toBeGreaterThan(300);
          expect(loading["composed unsized column ok"]!.box[3]).toBe(150);
          expect(loading["composed block ok"]!.box[3]).toBe(150);
          // A long error scrolls inside that box from its top instead of overflowing above it out of reach.
          const long = await page.evaluate(() => {
            const viewer = document.querySelector<HTMLElement>('[data-case="composed unsized column long"] [data-state="error"]')!;
            const icon = viewer.querySelector(".k2b-placeholder__icon")!;
            return {
              overflow: viewer.scrollHeight - viewer.clientHeight,
              iconOffset: icon.getBoundingClientRect().top - viewer.getBoundingClientRect().top,
            };
          });
          expect(long.overflow).toBeGreaterThan(0);
          expect(long.iconOffset).toBeGreaterThanOrEqual(0);
        } finally {
          await page.close();
        }
      });
    }
  }
});
