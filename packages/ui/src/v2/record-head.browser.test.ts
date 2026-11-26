import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-record-head.client";
import { measureV2Layout } from "./testing";

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-record-head.client.tsx", "dom"), launchBrowser()]);
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

// W4 (Grids): a record head with a long name pressed its identifiers to 0 px where the head had no room, and the layout
// check said their text was gone. Identifiers give way whole (out of sight, still in the page for assistive technology,
// and in the name's hint), then the name is cut with "…"; the head's deeds never leave their row.

for (const width of [1024, 390])
  test(`a long record name with three identifiers keeps each identifier whole or out of sight at ${width} px`, async () => {
    await withPage(width, async (page) => {
      const found = await page.evaluate(() => {
        const bar = document.querySelector("[data-slot='head'] > .k2-bar")!.getBoundingClientRect();
        const ids = Array.from(document.querySelectorAll<HTMLElement>(".k2-record-id")).map((id) => {
          const box = id.getBoundingClientRect();
          // away: not shown at all, or wrapped below the line that holds them; whole: in that line with all its words; cut:
          // anything else (pressed to a few px or clipped)
          const line = id.closest(".k2-record-ids")?.getBoundingClientRect() ?? bar;
          if (!id.checkVisibility() || box.top >= line.bottom - 0.5) return "away";
          return box.width > 1 && id.scrollWidth <= id.clientWidth + 1 && box.right <= bar.right + 0.5 ? "whole" : "cut";
        });
        const deeds = Array.from(document.querySelectorAll(".k2-bar-end > .k2-btn")).every((button) => {
          const box = button.getBoundingClientRect();
          // a deed the phone head folds away is no deed out of its row
          return box.width === 0 || box.right <= bar.right + 0.5;
        });
        const name = document.querySelector(".k2-record-name")!;
        return { ids, deeds, hint: name.getAttribute("title") ?? "" };
      });
      expect(found.ids.every((id) => id === "whole" || id === "away")).toBe(true);
      // on the phone the head grows instead, and the identifiers leave
      if (width < 768) expect(found.ids).toEqual(["away", "away", "away"]);
      expect(found.deeds).toBe(true);
      // what gave way stays reachable: the name says all of its identifiers on hover
      expect(found.hint).toContain("Tabelle INV-2026-0042");
      expect(found.hint).toContain("Ada Renz");
      const layout = await measureV2Layout(page, { root: "#root" });
      expect(layout.squeezed).toEqual([]);
      expect(layout.problems).toEqual([]);
    });
  });
