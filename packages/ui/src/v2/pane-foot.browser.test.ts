import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-pane-foot.client";
import { measureV2Layout } from "./testing";

// The foot of a column (`Pane foot`, test/v2-pane-foot.client.tsx: a long form of settings): in the flow at the end of
// the column while nothing changed; with unsaved changes on the bottom of the column while it scrolls, so "Speichern"
// is in reach from the first field. The last field stays above it, and on the phone the floating main action too.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-pane-foot.client.tsx", "dom"), launchBrowser()]);
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

/** Where the foot stands against the column it scrolls in. */
const place = (page: Page) =>
  page.evaluate(() => {
    const scroll = document.querySelector(".k2-pane > .k2-scroll")!;
    const bar = scroll.querySelector('[data-slot="foot"] > .k2-bar')!.getBoundingClientRect();
    const column = scroll.getBoundingClientRect();
    const fields = [...scroll.querySelectorAll(".k2-field")];
    const last = fields[fields.length - 1]!.getBoundingClientRect();
    const fab = document.querySelector(".k2-fab");
    const fabBox = fab && getComputedStyle(fab).display !== "none" ? fab.getBoundingClientRect() : null;
    return {
      scrolled: scroll.scrollTop,
      scrolls: scroll.scrollHeight > scroll.clientHeight + 100,
      onBottom: Math.abs(bar.bottom - column.bottom) <= 1,
      inView: bar.top < column.bottom && bar.bottom > column.top,
      lastAbove: last.bottom <= bar.top + 0.5,
      fabAbove: fabBox ? fabBox.bottom <= bar.top + 0.5 : true,
    };
  });

for (const width of [1440, 390])
  test(`at ${width}: a column's foot ends the form, and with a change it stays on the bottom of the column, above nothing it hides`, async () => {
    await withPage(width, async (page) => {
      const before = await place(page);
      expect(before.scrolls).toBe(true);
      // nothing changed: the foot stands after the last field, out of sight at the top of a long form
      expect(before.inView).toBe(false);
      await page.getByRole("textbox", { name: "Name der Installation" }).fill("Werkstatt Nord");
      await settled(page);
      const changed = await place(page);
      // changed while the column stands at its top: the save is on the bottom of the column, in sight
      expect(changed.scrolled).toBeLessThan(200);
      expect(changed.onBottom).toBe(true);
      expect(changed.fabAbove).toBe(true);
      // at the end of the column the last field stands above it
      await page.locator(".k2-pane > .k2-scroll").evaluate((scroll) => {
        scroll.scrollTop = scroll.scrollHeight;
      });
      await settled(page);
      const end = await place(page);
      expect(end.onBottom).toBe(true);
      expect(end.lastAbove).toBe(true);
      expect(end.fabAbove).toBe(true);
      // one line above the foot, from edge to edge, and every other rule of the layout
      expect((await measureV2Layout(page)).problems).toEqual([]);
      // saved: it goes back into the flow, out of sight again at the top
      await page.getByRole("button", { name: "Speichern" }).click();
      await page.locator(".k2-pane > .k2-scroll").evaluate((scroll) => {
        scroll.scrollTop = 0;
      });
      await settled(page);
      expect((await place(page)).inView).toBe(false);
      expect((await measureV2Layout(page)).problems).toEqual([]);
    });
  });
