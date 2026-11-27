import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-technical-values.client";
import { measureV2Layout } from "./testing";

// Technical values and key figures on a record (test/v2-technical-values.client.tsx, a client of the sign-in service):
// a redirect address breaks between its parts, never inside a word; a table column of fingerprints is monospace at
// the row's height; key figures stand two in a row on the phone, a last one alone across the row.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-technical-values.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
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

/**
 * The text of each line an element shows, read from where each character stands, and the lines that end inside a
 * part of the value although they hold a sign: such a line could have broken after that sign. A line may end inside a
 * part only where that part alone is longer than the line (then the line holds no sign).
 */
const linesOf = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const signs = "/.?&=#:,;_@+-";
    return [...document.querySelectorAll(selector)].map((element) => {
      const range = document.createRange();
      const lines: string[] = [];
      let top: number | undefined;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        for (let index = 0; index < node.textContent!.length; index += 1) {
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const box = range.getBoundingClientRect();
          if (!box.width) continue;
          if (top === undefined || Math.abs(box.top - top) > 4) lines.push(node.textContent![index]!);
          else lines.push(`${lines.pop() ?? ""}${node.textContent![index]}`);
          top = box.top;
        }
      const midWord = lines
        .slice(0, -1)
        .filter((line) => !signs.includes(line.trimEnd().slice(-1)) && [...line].some((char) => signs.includes(char)));
      return { lines, midWord };
    });
  }, selector);

for (const width of [1024, 390])
  test(`at ${width}: a redirect address breaks between its parts, in facts and in a table that wraps`, async () => {
    await withPage(width, async (page) => {
      const values = [
        ...(await linesOf(page, ".k2-fact-value[data-mono]")),
        ...(await linesOf(page, ".k2-table:not([data-sized]) .k2-cell-line[data-mono]")),
      ];
      // the long addresses wrap at all, and no line but a full one ends inside a word
      expect(values.filter((value) => value.lines.length > 1).length).toBeGreaterThanOrEqual(2);
      expect(values.flatMap((value) => value.midWord)).toEqual([]);
      expect((await measureV2Layout(page)).problems).toEqual([]);
    });
  });

test("at 1024: a column of fingerprints is monospace, cut with an ellipsis, and its rows are as high as any row", async () => {
  await withPage(1024, async (page) => {
    const found = await page.evaluate(() => {
      const table = (label: string) => document.querySelector(`table.k2-table[aria-label="${label}"]`)!;
      const keys = table("Schlüssel");
      const line = keys.querySelector("tbody .k2-cell-line[data-mono]")!;
      const heights = (scroll: Element) => [...scroll.querySelectorAll("tbody tr")].map((row) => row.getBoundingClientRect().height);
      return {
        mono: getComputedStyle(line).fontFamily.includes("monospace"),
        cut: getComputedStyle(line).textOverflow,
        keys: heights(keys),
        events: heights(table("Ereignisse")),
      };
    });
    expect({ mono: found.mono, cut: found.cut, rows: found.keys }).toEqual({ mono: true, cut: "ellipsis", rows: found.events });
  });
});

test("at 390: key figures stand two in a row and a last one alone takes the whole row; at 1024 they stand in one row", async () => {
  for (const width of [390, 1024])
    await withPage(width, async (page) => {
      const cells = await page.evaluate(() => {
        const row = document.querySelector(".k2-cells")!.getBoundingClientRect();
        return [...document.querySelectorAll(".k2-cells > .k2-cell")].map((cell) => {
          const box = cell.getBoundingClientRect();
          return { share: Math.round((box.width / row.width) * 100), top: Math.round(box.top - row.top) };
        });
      });
      if (width === 390) {
        expect(cells.map((cell) => cell.share)).toEqual([50, 50, 100]);
        expect(new Set(cells.map((cell) => cell.top)).size).toBe(2);
      } else expect(new Set(cells.map((cell) => cell.top)).size).toBe(1);
      expect((await measureV2Layout(page)).problems).toEqual([]);
    });
});
