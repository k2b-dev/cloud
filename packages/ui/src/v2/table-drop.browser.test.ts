import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-table-drop.client";

// The columns of a table that may drop (`drop`) give way by the table's own width, not the window's: Files' list
// beside its open detail at 1024 px (test/v2-table-drop.client.tsx) drops "Geändert", then "Besitzer", so "Größe"
// keeps its words; with the detail closed every column stands. The stylesheet decides, so already the first frame
// after the detail opens or closes shows the columns it keeps.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-table-drop.client.tsx", "dom"), launchBrowser()]);
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

/** The table in sight: the columns that stand, whether it fits its box, and every head and cell that is cut. */
const table = () => {
  const scroll = document.querySelector<HTMLElement>(".k2-table-scroll")!;
  const box = scroll.getBoundingClientRect();
  const heads = [...scroll.querySelectorAll<HTMLElement>("thead th")];
  const shown = heads.filter((head) => head.getBoundingClientRect().width > 0).map((head) => head.textContent?.trim() ?? "");
  const lines = [...scroll.querySelectorAll<HTMLElement>("th, .k2-cell-line")].filter((line) => line.getBoundingClientRect().width > 0);
  return {
    width: Math.round(box.width),
    shown,
    fits: (scroll.querySelector("table")?.getBoundingClientRect().width ?? 0) <= box.width + 0.5,
    cut: lines.filter((line) => line.scrollWidth > line.clientWidth + 0.5).map((line) => line.textContent?.trim() ?? ""),
  };
};

test("at 1024 px the list beside its open detail drops its columns in their order; closed, every column stands", async () => {
  await withPage(1024, async (page) => {
    const closed = await page.evaluate(table);
    expect(closed).toEqual({ ...closed, shown: ["Name", "Geändert", "Besitzer", "Größe"], fits: true, cut: [] });
    // the first frame after the detail opens already keeps only the columns that have room
    // settled: the first frame is the subject
    const first = await page.evaluate(
      () =>
        new Promise<string[]>((done) => {
          window.__k2Detail?.(true);
          requestAnimationFrame(() =>
            done(
              [...document.querySelectorAll<HTMLElement>(".k2-table-scroll thead th")]
                .filter((head) => head.getBoundingClientRect().width > 0)
                .map((head) => head.textContent?.trim() ?? ""),
            ),
          );
        }),
    );
    await settled(page);
    const open = await page.evaluate(table);
    expect(open.width).toBeLessThan(closed.width);
    expect(open.fits).toBe(true);
    expect(open.cut.filter((text) => /^(Größe|4,2 MB|812 KB|1,4 GB)$/.test(text))).toEqual([]);
    // what drops, drops in its order: "Geändert" before "Besitzer"; name and size stay
    expect(["Name,Besitzer,Größe", "Name,Größe"]).toContain(open.shown.join(","));
    expect(first).toEqual(open.shown);
    // and closed again, every column stands again
    await page.evaluate(() => window.__k2Detail?.(false));
    await settled(page);
    expect((await page.evaluate(table)).shown).toEqual(["Name", "Geändert", "Besitzer", "Größe"]);
  });
});

// The columns drop one by one as the table narrows, never more than its room asks: at each width the columns that
// stand fit, and one more would not.
test("as the table narrows, its columns that may drop give way one by one, in their order", async () => {
  await withPage(1024, async (page) => {
    const seen = new Set<string>();
    for (const width of [1024, 900, 800, 720, 640, 600, 560, 500]) {
      await page.evaluate((px) => {
        document.getElementById("root")!.style.width = `${px}px`;
      }, width);
      await settled(page);
      const found = await page.evaluate(table);
      expect({ at: width, ...found }).toEqual({ at: width, ...found, fits: true });
      expect(found.cut.filter((text) => /^(Größe|4,2 MB|812 KB|1,4 GB)$/.test(text))).toEqual([]);
      expect(["Name,Geändert,Besitzer,Größe", "Name,Besitzer,Größe", "Name,Größe"]).toContain(found.shown.join(","));
      seen.add(found.shown.join(","));
    }
    expect([...seen]).toEqual(["Name,Geändert,Besitzer,Größe", "Name,Besitzer,Größe", "Name,Größe"]);
  });
});
