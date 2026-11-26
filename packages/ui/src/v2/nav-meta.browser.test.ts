import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-nav-meta.client";
import { measureV2Layout } from "./testing";

// W7 (Assistant #4280): a sidebar entry had no second line, so a chat "an Orten" lost its place. An entry's `meta` is a
// quiet second line under its name: one line, cut with "…", and part of the entry's name for assistive technology.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-nav-meta.client.tsx", "dom"), launchBrowser()]);
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

for (const width of [1440, 390])
  test(`a sidebar entry says its place on a quiet second line of one line at ${width} px`, async () => {
    await withPage(width, async (page) => {
      // part of the entry's name, after the name
      await page
        .getByRole("link", {
          name: "Abnahme der Musterfronten nach dem zweiten Ölen mit der Kundin Werkstatt Lindenstraße 12, Halle 3, hinten links beim Rolltor",
          exact: true,
        })
        .waitFor();
      await page.getByRole("link", { name: "Angebot Küche Läuft Büro", exact: true }).waitFor();
      const entries = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".k2-ni")).map((entry) => {
          const name = entry.querySelector(".k2-ni-name")!;
          const meta = entry.querySelector<HTMLElement>(".k2-ni-meta");
          const lines = (element: Element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top))).size;
          };
          return {
            height: Math.round(entry.getBoundingClientRect().height),
            name: lines(name),
            meta: meta ? lines(meta) : 0,
            below: meta ? meta.getBoundingClientRect().top >= name.getBoundingClientRect().bottom - 1 : null,
            cut: meta ? meta.scrollWidth > meta.clientWidth : null,
            quiet: meta ? getComputedStyle(meta).fontSize !== getComputedStyle(name).fontSize : null,
            inside: meta ? meta.getBoundingClientRect().right <= entry.getBoundingClientRect().right + 0.5 : null,
          };
        }),
      );
      const [long, short, plain] = entries;
      // the long name and the long place stay on one line each, the place under the name, quieter, cut with "…"
      expect(long).toEqual(expect.objectContaining({ name: 1, meta: 1, below: true, cut: true, quiet: true, inside: true }));
      expect(short).toEqual(expect.objectContaining({ name: 1, meta: 1, below: true, cut: false, quiet: true, inside: true }));
      // an entry without a place keeps its one line and its height; one with a place is taller by one quiet line
      expect(plain).toEqual(expect.objectContaining({ name: 1, meta: 0 }));
      expect(long!.height).toBeGreaterThan(plain!.height);
      expect(long!.height).toBe(short!.height);
      expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
    });
  });

// Review of #4293: under the pointer an entry with deeds shows its "…" over the end of its first line; its second line
// keeps its width and its cut, so nothing jumps.
test("under the pointer the … of an entry takes room in its first line only", async () => {
  await withPage(1440, async (page) => {
    const entry = page.locator(".k2-ni-row", { hasText: "Lager" });
    const read = () =>
      entry.evaluate((row) => {
        const meta = row.querySelector(".k2-ni-meta")!;
        const name = row.querySelector(".k2-ni-name")!.getBoundingClientRect();
        const more = row.querySelector(":scope > .k2-btn")!.getBoundingClientRect();
        return {
          meta: [Math.round(meta.getBoundingClientRect().left), Math.round(meta.getBoundingClientRect().right), meta.clientWidth],
          clear: name.right <= more.left + 0.5,
        };
      });
    const before = await read();
    await entry.hover();
    await settled(page);
    const under = await read();
    expect(under.meta).toEqual(before.meta);
    // the name ends before the "…"
    expect(under.clear).toBe(true);
  });
});
