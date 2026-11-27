import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-section-head.client";
import { typeRoles } from "./tokens";

// The section head as Valentin chose it on 27.11. (settings-headings-study v2): A everywhere (no symbol, a calm title
// of 15 px, the count quiet beside it, the summary as the muted line right under it, the deeds at the end) and B for
// the sections of a settings or form screen (`form`) in a wide pane (title, summary and deeds in a column of 240 px at
// the left, the content at the right). The pane's width decides, not the window's. Lines: the line between sections is
// clearly stronger than the very subtle lines between rows. The fixture is test/v2-section-head.client.tsx.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss = "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-section-head.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (which: "form" | "narrow" | "detail", width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: `window.__k2Case = ${JSON.stringify(which)};` });
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** The first section's parts, rounded to whole px. */
const shape = (page: Page) =>
  page.evaluate(() => {
    const section = document.querySelector<HTMLElement>('[data-k2-part="Section"]')!;
    const box = (element: Element | null) => {
      const r = element?.getBoundingClientRect();
      return r ? { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) } : null;
    };
    const title = section.querySelector("h3")!;
    const style = getComputedStyle(title);
    const count = section.querySelector(".k2-sh-count");
    return {
      section: box(section),
      head: box(section.querySelector(".k2-sh")),
      title: box(title),
      summary: box(section.querySelector(".k2-sec-summary")),
      actions: box(section.querySelector(".k2-sh-end")),
      count: box(count),
      firstRow: box(section.querySelector('[data-k2-part="Row"]')),
      font: `${style.fontSize}/${style.lineHeight} ${style.fontWeight}`,
      countWeight: count ? getComputedStyle(count).fontWeight : null,
      // a symbol in the head, other than inside its buttons
      symbols: section.querySelectorAll(".k2-sh .k2-stile, .k2-sh > .k2-icon, .k2-sh-title .k2-icon").length,
    };
  });

/** A: the summary right under the title, the deeds on the title's row at the end, the content under the head. */
const expectA = (found: Awaited<ReturnType<typeof shape>>) => {
  expect(found.summary!.top - found.title!.bottom).toBeLessThanOrEqual(4);
  expect(found.summary!.left).toBe(found.title!.left);
  expect(Math.abs((found.actions!.top + found.actions!.bottom) / 2 - (found.title!.top + found.title!.bottom) / 2)).toBeLessThanOrEqual(8);
  expect(found.actions!.right).toBeGreaterThan(found.section!.right - 40);
  expect(found.firstRow!.top).toBeGreaterThanOrEqual(found.summary!.bottom);
};

const title = typeRoles.title;

test("every head: no symbol, a calm title of 15 px at 600, the count quiet beside it", async () => {
  for (const which of ["form", "detail"] as const)
    await withPage(which, 1440, async (page) => {
      const found = await shape(page);
      expect([found.symbols, found.font, found.countWeight]).toEqual([0, `${title.size}px/${title.lineHeight}px ${title.weight}`, "400"]);
      expect(Math.abs(found.count!.bottom - found.title!.bottom)).toBeLessThanOrEqual(3);
    });
});

test("1440 px, a settings screen (`form`) in a wide pane: B, the head a column of 240 px at the left, the content beside it", async () => {
  await withPage("form", 1440, async (page) => {
    const found = await shape(page);
    // the head column: title, summary under it, the deeds under the summary
    expect(found.head!.right - found.section!.left).toBeLessThanOrEqual(240 + 1);
    expect(found.summary!.top).toBeGreaterThanOrEqual(found.title!.bottom);
    expect(found.actions!.top).toBeGreaterThanOrEqual(found.summary!.bottom);
    expect(found.actions!.right).toBeLessThanOrEqual(found.section!.left + 240);
    // the content starts 40 px after the column, on the head's top
    expect(found.firstRow!.left).toBeGreaterThanOrEqual(found.section!.left + 240 + 40 - 20);
    expect(found.firstRow!.top).toBeLessThan(found.summary!.bottom);
  });
});

test("390 px, the same settings screen: A, as the pane is narrow", async () => {
  await withPage("form", 390, async (page) => {
    expectA(await shape(page));
  });
});

test("1440 px, a settings section in a pane of 420 px: A, the pane decides and not the window", async () => {
  await withPage("narrow", 1440, async (page) => {
    expectA(await shape(page));
  });
});

test("1440 px, a detail page: A, an ordinary section never takes B", async () => {
  await withPage("detail", 1440, async (page) => {
    expectA(await shape(page));
  });
});

test("the line between sections is clearly stronger than the very subtle lines between rows and table rows", async () => {
  await withPage("form", 1440, async (page) => {
    const lines = await page.evaluate(() => {
      const color = (element: Element | null) => (element ? getComputedStyle(element).borderBottomColor : null);
      return {
        section: color(document.querySelector('[data-k2-part="Section"]')),
        row: color(document.querySelector('.k2-list > [data-k2-part="Row"]')),
        cell: color(document.querySelector(".k2-table tbody tr:first-child td")),
      };
    });
    // all 1 px: between sections n300, between rows n100 (structure keeps n200)
    expect(lines).toEqual({ section: "rgb(212, 212, 216)", row: "rgb(244, 244, 245)", cell: "rgb(244, 244, 245)" });
  });
});
