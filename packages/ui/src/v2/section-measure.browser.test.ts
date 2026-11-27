import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-section-measure.client";
import { measureV2Layout } from "./testing";
import { textEdge } from "./tokens";

// W2 (Notebooks start): in a pane of 1400 px a short list of ways to start stood with its words at the left edge and its
// deeds at the right, far apart. A section with `measure` holds its head, sentence and rows to the reading measure of
// `Prose` (720 px of text between the text edges); its line still reaches the column's edges.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-section-measure.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

for (const width of [1440, 1024, 390])
  test(`a section with measure keeps its content to the reading measure, its line to the edges, at ${width} px`, async () => {
    await withPage(width, async (page) => {
      const found = await page.evaluate(() => {
        const [held, free] = Array.from(document.querySelectorAll<HTMLElement>(".k2-sec"));
        const right = (element: Element) => Math.round(element.getBoundingClientRect().right);
        const prose = document.querySelector(".k2-prose")!;
        return {
          pane: Math.round(held!.closest(".k2-pane")!.getBoundingClientRect().width),
          line: right(held!) === right(free!),
          rows: Array.from(held!.querySelectorAll(".k2-row")).map(right),
          head: right(held!.querySelector(".k2-sh")!),
          prose: right(prose),
          freeRow: right(free!.querySelector(".k2-row")!),
          left: Math.round(held!.getBoundingClientRect().left),
        };
      });
      const edge = width < textEdge.phoneBelow ? textEdge.phone : textEdge.wide;
      // the reading measure: 720 px of text between the two text edges, as Prose
      const measure = Math.min(found.pane, 720 + 2 * edge);
      expect(found.line).toBe(true);
      for (const row of found.rows) expect(row - found.left).toBe(measure);
      expect(found.head - found.left).toBe(measure);
      // the same right end as a reading text; a section without measure keeps the whole width
      expect(found.prose - found.left).toBe(measure);
      expect(found.freeRow - found.left).toBe(found.pane);
      expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
    });
  });
