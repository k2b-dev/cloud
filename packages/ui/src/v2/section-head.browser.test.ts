import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-section-head.client";
import { measureV2Layout } from "./testing";
import { typeRoles } from "./tokens";

// The section head as Valentin chose it on 27.11. (settings-headings-study v2, taste study v2 rules 1, 4, 5 and 8): A
// in a narrow pane (no symbol, a calm title of 15 px, the count quiet beside it, the summary as the muted line right
// under it, framed deeds at the end) and B in a pane of 960 px and more, by default (title, summary and deeds in a
// column of 232 px, the content 48 px beside it, the whole section at most 1040 px). The pane's width decides, not the
// window's; a section that holds a table keeps A and its full width. Lines: the clear line between sections, the hair
// between rows. The fixture is test/v2-section-head.client.tsx.

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

const withPage = async (which: "form" | "narrow" | "detail" | "custom", width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: `window.__k2SectionCase = ${JSON.stringify(which)};` });
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

test("every head: no symbol, a calm title of 15 px at 600 (also in B), the count quiet beside it", async () => {
  for (const [which, width, font] of [
    ["detail", 1440, `${title.size}px/${title.lineHeight}px ${title.weight}`],
    ["form", 390, `${title.size}px/${title.lineHeight}px ${title.weight}`],
    ["form", 1440, `${title.size}px/${title.lineHeight}px ${title.weight}`],
  ] as const)
    await withPage(which, width, async (page) => {
      const found = await shape(page);
      expect([which, width, found.symbols, found.font, found.countWeight]).toEqual([which, width, 0, font, "400"]);
      expect(Math.abs(found.count!.bottom - found.title!.bottom)).toBeLessThanOrEqual(3);
    });
});

test("1440 px, a wide pane: B by default, the head a column of 232 px, the content 48 px beside it, the section 1040 px", async () => {
  await withPage("form", 1440, async (page) => {
    const found = await shape(page);
    // the head column: title, summary under it, the deeds under the summary
    expect(found.head!.right - found.section!.left).toBe(232);
    expect(found.summary!.top).toBeGreaterThanOrEqual(found.title!.bottom);
    expect(found.actions!.top).toBeGreaterThanOrEqual(found.summary!.bottom);
    expect(found.actions!.right).toBeLessThanOrEqual(found.section!.left + 232);
    // the content column starts 48 px after the head column, on the head's top, and ends with the section
    expect(found.firstRow!.left).toBe(found.section!.left + 232 + 48);
    expect(found.firstRow!.right).toBe(found.section!.right);
    expect(found.firstRow!.top).toBeLessThan(found.summary!.bottom);
    // the measure: the section and its line end at 1040 px, from the text edge
    expect(found.section!.right - found.section!.left).toBe(1040);
  });
});

test("1440 px, the deeds of a section head are framed buttons of 30 px with their verb", async () => {
  for (const width of [1440, 390])
    await withPage("form", width, async (page) => {
      const button = await page.evaluate(() => {
        const element = document.querySelector<HTMLElement>(".k2-sh-end > .k2-btn")!;
        const style = getComputedStyle(element);
        return { height: element.getBoundingClientRect().height, border: style.borderTopWidth, words: element.innerText.trim() };
      });
      expect(button).toEqual({ height: 30, border: "1px", words: "Zeiten" });
    });
});

test("390 px, the same settings screen: A, as the pane is narrow", async () => {
  await withPage("form", 390, async (page) => {
    expectA(await shape(page));
  });
});

test("B begins at a pane of exactly 960 px: at 959 px the head stands over its content (A)", async () => {
  // the window's width beside the pane: the frame of the workspace
  let frame = 0;
  await withPage("form", 1440, async (page) => {
    frame = 1440 - (await page.evaluate(() => document.querySelector(".k2-pane")!.getBoundingClientRect().width));
  });
  const floats: Record<number, string> = {};
  for (const pane of [959, 960])
    await withPage("form", pane + frame, async (page) => {
      const found = await page.evaluate(() => ({
        pane: document.querySelector(".k2-pane")!.getBoundingClientRect().width,
        float: getComputedStyle(document.querySelector('[data-k2-part="Section"] > .k2-sh')!).float,
      }));
      expect(found.pane).toBe(pane);
      floats[pane] = found.float;
    });
  expect(floats).toEqual({ 959: "none", 960: "left" });
});

test("1440 px, a settings section in a pane of 420 px: A, the pane decides and not the window", async () => {
  await withPage("narrow", 1440, async (page) => {
    expectA(await shape(page));
  });
});

test("1440 px, a section that holds a large table keeps A and its full width", async () => {
  await withPage("detail", 1440, async (page) => {
    const found = await shape(page);
    expectA(found);
    // from the pane's edge (the workspace's frame is 1 px), not inset to a measure
    expect(found.section!.left).toBeLessThanOrEqual(1);
  });
});

test("the clear line stands between sections, the hair between rows and table rows", async () => {
  await withPage("form", 1440, async (page) => {
    const lines = await page.evaluate(() => {
      const color = (element: Element | null) => (element ? getComputedStyle(element).borderBottomColor : null);
      return {
        section: color(document.querySelector('[data-k2-part="Section"]')),
        between: getComputedStyle(document.querySelector('[data-k2-part="Section"] > [data-k2-part="Row"] + [data-k2-part="Row"]')!)
          .borderTopColor,
        row: color(document.querySelector('.k2-list > [data-k2-part="Row"]')),
        cell: color(document.querySelector(".k2-table tbody tr:first-child td")),
      };
    });
    // all 1 px: between sections #e4e4e7, between rows #f0f0f2, nothing under the last
    expect(lines).toEqual({
      section: "rgb(228, 228, 231)",
      between: "rgb(240, 240, 242)",
      row: "rgb(240, 240, 242)",
      cell: "rgb(240, 240, 242)",
    });
  });
});

test("the last section of a pane draws no line under itself (its pixel stays, so nothing moves)", async () => {
  await withPage("detail", 1440, async (page) => {
    const last = await page.evaluate(() => {
      const section = document.querySelector('[data-k2-part="Section"]')!;
      const style = getComputedStyle(section);
      return [section === section.parentElement?.lastElementChild, style.borderBottomWidth, style.borderBottomColor];
    });
    expect(last).toEqual([true, "1px", "rgba(0, 0, 0, 0)"]);
  });
});

test("1440 px, B: an app's own plain part, in a section and in a folding one, stands in the content column", async () => {
  await withPage("custom", 1440, async (page) => {
    const found = await page.evaluate(() =>
      ["custom", "custom-folded"].map((probe) => {
        const element = document.querySelector(`[data-probe="${probe}"]`)!;
        const section = element.closest('[data-k2-part="Section"]')!.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return { left: Math.round(box.left - section.left), right: Math.round(section.right - box.right) };
      }),
    );
    expect(found).toEqual([
      { left: 232 + 48, right: 0 },
      { left: 232 + 48, right: 0 },
    ]);
    expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
  });
});
