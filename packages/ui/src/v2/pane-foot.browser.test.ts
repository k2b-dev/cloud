import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-pane-foot.client";
import { measureV2Layout } from "./testing";

// The foot of a column (`Pane foot`, test/v2-pane-foot.client.tsx: a long form of settings, alone or beside an info
// column): in the flow at the end of the column while nothing changed; with unsaved changes on the bottom of the
// column while it scrolls, so "Speichern" is in reach from the first field. It never covers the field that has the
// focus, and one line stands above it, whatever part ends the column.

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

type Layout = "pane" | "split" | "list";
type Last = "section" | "notice" | "band" | "table";

const withPage = async (width: number, layout: Layout, last: Last, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.evaluate(([layout, last]) => Object.assign(window, { __k2Layout: layout, __k2Last: last }), [layout, last]);
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const change = async (page: Page) => {
  await page.getByRole("textbox", { name: "Name der Installation" }).fill("Werkstatt Nord");
  await settled(page);
};

/** The element that scrolls the form: the nearest ancestor of the foot that scrolls, and where its view ends. */
const scrollerOf = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector('[data-slot="foot"] > .k2-bar')!;
    let scroller = bar.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowY)))
      scroller = scroller.parentElement;
    return scroller === null ? "none" : scroller.matches(".k2-pane > .k2-scroll") ? "pane" : scroller.className || scroller.tagName;
  });

const toEnd = (page: Page) =>
  page.evaluate(() => {
    for (const element of document.querySelectorAll<HTMLElement>("*"))
      if (element.scrollHeight > element.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(element).overflowY))
        element.scrollTop = element.scrollHeight;
  });

/** Where the foot stands: on the bottom of what shows of its column, and the last field above it. */
const place = (page: Page) =>
  page.evaluate(() => {
    const scroll = document.querySelector('.k2-pane > .k2-scroll:has(> [data-slot="foot"])')!;
    const bar = scroll.querySelector('[data-slot="foot"] > .k2-bar')!.getBoundingClientRect();
    const column = scroll.getBoundingClientRect();
    const shown = Math.min(column.bottom, window.innerHeight);
    const fields = [...scroll.querySelectorAll(".k2-field")];
    const last = fields[fields.length - 1]!.getBoundingClientRect();
    return {
      onBottom: Math.abs(bar.bottom - shown) <= 1,
      inView: bar.top < shown && bar.bottom > Math.max(column.top, 0),
      lastAbove: last.bottom <= bar.top + 0.5,
      mask: getComputedStyle(scroll).maskImage,
    };
  });

for (const width of [1440, 390])
  for (const layout of ["pane", "split"] as const)
    test(`${layout} at ${width}: the foot ends the form, and with a change it stays on the bottom of the column in sight`, async () => {
      await withPage(width, layout, "section", async (page) => {
        // nothing changed: the foot stands after the last field, out of sight at the top of a long form
        expect((await place(page)).inView).toBe(false);
        await change(page);
        // the column scrolls the form, and the foot stays on the bottom of what shows of it, unmasked
        expect(await scrollerOf(page)).toBe(layout === "split" && width === 390 ? "k2-split" : "pane");
        const changed = await place(page);
        expect(changed.onBottom).toBe(true);
        expect(changed.inView).toBe(true);
        expect(changed.mask).toBe("none");
        // at the end of the column the last field stands above it, under one line
        await toEnd(page);
        await settled(page);
        const end = await place(page);
        expect(end.onBottom).toBe(true);
        expect(end.lastAbove).toBe(true);
        expect((await measureV2Layout(page)).problems).toEqual([]);
        // saved: it goes back into the flow, at the end of the form
        await page.getByRole("button", { name: "Speichern" }).click();
        await settled(page);
        expect((await measureV2Layout(page)).problems).toEqual([]);
      });
    });

for (const width of [1440, 390])
  for (const layout of ["pane", "split"] as const)
    test(`${layout} at ${width}: a field that takes the focus by Tab stands whole above the foot`, async () => {
      await withPage(width, layout, "section", async (page) => {
        await change(page);
        const inputs = await page
          .locator('[data-slot="foot"]')
          .evaluate((foot) => foot.closest(".k2-scroll")!.querySelectorAll("input").length);
        const hidden: string[] = [];
        for (let index = 1; index < inputs; index += 1) {
          await page.keyboard.press("Tab");
          // an engine may scroll the focused field into view with the next frame
          await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
          const seen = await page.evaluate(() => {
            const field = document.activeElement as HTMLElement;
            const bar = document.querySelector('[data-slot="foot"] > .k2-bar')!.getBoundingClientRect();
            const box = field.getBoundingClientRect();
            // the top of what shows of the column: the top of the element that scrolls it
            let scroller = field.parentElement;
            while (
              scroller &&
              !(scroller.scrollHeight > scroller.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))
            )
              scroller = scroller.parentElement;
            const top = scroller?.getBoundingClientRect().top ?? 0;
            return {
              name: field.getAttribute("name") ?? field.id,
              input: field.tagName === "INPUT",
              whole: box.bottom <= bar.top + 0.5 && box.top >= top - 0.5,
            };
          });
          if (seen.input && !seen.whole) hidden.push(seen.name);
        }
        expect(hidden).toEqual([]);
      });
    });

for (const width of [1440, 390])
  for (const last of ["notice", "band", "table"] as const)
    test(`at ${width}: a column that ends with a ${last} has one line above its foot, in the flow and while it stays`, async () => {
      await withPage(width, "pane", last, async (page) => {
        await toEnd(page);
        await settled(page);
        expect((await measureV2Layout(page)).problems).toEqual([]);
        await change(page);
        await toEnd(page);
        await settled(page);
        expect((await measureV2Layout(page)).problems).toEqual([]);
      });
    });

for (const width of [1440, 390])
  test(`list at ${width}: a long list alone in a split scrolls in its own pane, under a status that stays, where its scrollKey reads`, async () => {
    await withPage(width, "list", "section", async (page) => {
      const where = () =>
        page.evaluate(() => ({
          status: Math.round(document.querySelector('[data-slot="status"]')!.getBoundingClientRect().top),
          kept: document.querySelector<HTMLElement>('.k2-scroll[data-scroll-preserve="liste"]')!.scrollTop,
        }));
      const before = await where();
      await page.mouse.move(width / 2, 500);
      await page.mouse.wheel(0, 1200);
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.k2-scroll[data-scroll-preserve="liste"]')!.scrollTop > 0);
      const after = await where();
      // the list scrolled in the region the page restores by its scrollKey, and the status did not move
      expect(after.kept).toBeGreaterThan(0);
      expect(after.status).toBe(before.status);
      expect((await measureV2Layout(page)).problems).toEqual([]);
    });
  });
