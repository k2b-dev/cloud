import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, launchHookMs, settled } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import * as watcher from "../_internal/runtime-watcher";

// A v2 visitor page in a measure (`MinimalLayout ui="v2" measure`): from 768 px its Workspace stands as one centred
// card on the canvas, at most 1200 px for a page and 560 px for one task; on the phone it spans the window.
const root = mkdtempSync(resolve(tmpdir(), "cloud-minimal-layout-measure-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MinimalLayout } = await import("./MinimalLayout");
const { PageFixture, TaskFixture } = await import("./minimal-layout-measure.test-fixture");
type Context = Parameters<typeof MinimalLayout>[0]["c"];
type Measure = "page" | "task";

const coreRoutes = spyOn(watcher, "registeredCoreRoutes").mockReturnValue(["/public/global.css", "/public/v2.css"]);

const render = (measure: Measure | undefined, kiosk = false) => {
  const context = {
    get: (key: string) => (key === "page" ? {} : key === "runtime" ? { apps: [] } : undefined),
    req: { raw: { headers: new Headers({ "Accept-Language": "en" }), url: "https://cloud.test/public/lindenhof" } },
  } as unknown as Context;
  return renderToString(() =>
    createComponent(MinimalLayout, {
      c: context,
      ui: "v2",
      measure,
      preferences: !kiosk,
      get children() {
        return createComponent(measure === "task" ? TaskFixture : PageFixture, {});
      },
    }),
  );
};

let browser: Browser;
let css = "";
beforeAll(async () => {
  const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../styles/v2-page.css")] });
  if (!built.success) throw new AggregateError(built.logs, "Could not build v2.css.");
  css = await built.outputs[0]!.text();
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  coreRoutes.mockRestore();
});

/** The card's width: the whole window on the phone, else the measure, or the window less its gutters where it is narrower. */
const expectedWidth = (measure: Measure, width: number) => (width < 768 ? width : Math.min(measure === "page" ? 1200 : 560, width - 48));

describe("MinimalLayout ui v2 measure", () => {
  test("the server writes the measure on the main area, and nothing without one", () => {
    expect(render("page")).toContain('<main class="minimal-layout-main" data-measure="page"');
    expect(render("task")).toContain('<main class="minimal-layout-main" data-measure="task"');
    expect(render(undefined)).not.toContain("data-measure");
    expect(render("page", true)).toContain('<main class="k2-ui minimal-layout-main" data-measure="page"');
  });

  for (const measure of ["page", "task"] as const)
    for (const theme of ["light", "dark"] as const)
      for (const width of [390, 1024, 1440, 1920])
        test(`${measure} at ${width} px, ${theme}: a centred card of its measure, clean, the footer after it`, async () => {
          const tab = await browser.newPage({ viewport: { width, height: 900 } });
          try {
            await tab.setContent(
              `<!doctype html><html lang="de" class="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
                `<body class="k2b-ui k2-ui">${render(measure)}</body></html>`,
            );
            await settled(tab);
            const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
            expect(layout.problems).toEqual([]);
            const boxes = await tab.evaluate(() => {
              const card = document.querySelector("[data-k2-workspace]")!;
              const box = (element: Element) => element.getBoundingClientRect().toJSON() as DOMRect;
              return {
                card: box(card),
                main: box(document.querySelector("main")!),
                footer: box(document.querySelector("footer")!),
                pageBackground: getComputedStyle(document.querySelector(".minimal-layout")!).backgroundColor,
                cardBackground: getComputedStyle(card).backgroundColor,
                cardEdge: getComputedStyle(card).borderTopWidth,
                scrollWidth: document.documentElement.scrollWidth,
              };
            });
            expect(boxes.scrollWidth).toBeLessThanOrEqual(width);
            expect(Math.round(boxes.card.width)).toBe(expectedWidth(measure, width));
            // centred: the same room on both sides
            expect(Math.abs(boxes.card.left - (width - boxes.card.right))).toBeLessThanOrEqual(0.5);
            expect(boxes.footer.top).toBeGreaterThanOrEqual(boxes.card.bottom - 0.5);
            if (width < 768) {
              // the phone: the content spans the window from its top, on the page's surface, without an edge of its own
              expect(boxes.card.top).toBe(0);
              expect(boxes.cardEdge).toBe("0px");
              expect(boxes.pageBackground).toBe(boxes.cardBackground);
            } else {
              // one card with its thin edge on the canvas, 48 px below the window's top
              expect(boxes.card.top).toBe(48);
              expect(boxes.cardEdge).toBe("1px");
              expect(boxes.pageBackground).not.toBe(boxes.cardBackground);
              // the card ends with its content: a short task leaves the canvas between the card and the footer
              if (measure === "task") expect(boxes.card.bottom).toBeLessThan(boxes.main.bottom - 24);
            }
          } finally {
            await tab.close();
          }
        }, 30_000);
});
