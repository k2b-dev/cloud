import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-record-head.client";

// A record's head on the phone (W8, Weather at 390 px with a long place name; W7, the Kundenakte with four symbols):
// avatar, name and the head's actions stand in one row, as the approved mockup's 57 px head. The name comes before
// the kinds: it keeps at least 8ch and is cut with "…"; a kind without room beside it leaves the head, it never takes a
// second row. Before, avatar, name and "…" took a row each (about 140 px), then the name shrank to 40 px beside the
// kinds. The fixture is test/v2-record-head.client.tsx.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss = "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-record-head.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (kinds: boolean, width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: `window.__k2Kinds = ${kinds};` });
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const shape = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('.k2-ws-main > [data-slot="head"] > .k2-bar')!;
    const middle = (element: Element) => {
      const box = element.getBoundingClientRect();
      return Math.round(box.top + box.height / 2);
    };
    const name = bar.querySelector<HTMLElement>(".k2-record-name")!;
    const start = bar.querySelector<HTMLElement>(":scope > .k2-bar-start")!.getBoundingClientRect();
    // 8ch of the name's own font: the width of "0" eight times
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = getComputedStyle(name).font;
    const chips = [...bar.querySelectorAll(".k2-chip")];
    // a chip shows when its box lies inside the start's box (the start cuts what wrapped below it)
    const shows = (chip: Element) => {
      const box = chip.getBoundingClientRect();
      return box.width > 0 && box.top >= start.top - 0.5 && box.bottom <= start.bottom + 0.5;
    };
    return {
      height: Math.round(bar.getBoundingClientRect().height),
      name: middle(name),
      nameWidth: name.getBoundingClientRect().width,
      least: 8 * context.measureText("0").width,
      avatar: middle(bar.querySelector(".k2-av")!),
      actions: [...bar.querySelectorAll(":scope > .k2-bar-end .k2-btn")].map(middle),
      // the kinds that show, each on the name's row; none half cut at the start's edge
      kinds: chips.filter(shows).map(middle),
      halfCut: chips.filter((chip) => {
        const box = chip.getBoundingClientRect();
        return !shows(chip) && box.top < start.bottom - 0.5 && box.bottom > start.bottom + 0.5;
      }).length,
      cut: name.scrollWidth > name.clientWidth + 0.5,
      inside: bar.getBoundingClientRect().right <= innerWidth + 0.5,
    };
  });

test("390 px, a very long name with two kinds and four symbols: one row of 57 px, the name at least 8ch and cut, the kinds without room left out", async () => {
  await withPage(true, 390, async (page) => {
    const found = await shape(page);
    expect(found.height).toBe(57);
    expect(found.nameWidth).toBeGreaterThanOrEqual(found.least - 0.5);
    expect(found.actions).toHaveLength(4);
    expect([found.avatar, ...found.actions, ...found.kinds]).toEqual(
      [found.avatar, ...found.actions, ...found.kinds].map(() => found.name),
    );
    expect([found.halfCut, found.cut, found.inside]).toEqual([0, true, true]);
  });
});

test("390 px, a very long name without kinds: the same one row of 57 px", async () => {
  await withPage(false, 390, async (page) => {
    const found = await shape(page);
    expect(found.height).toBe(57);
    expect([found.avatar, ...found.actions]).toEqual([found.name, ...found.actions.map(() => found.name)]);
    expect([found.cut, found.inside]).toEqual([true, true]);
  });
});

test("1440 px, unchanged: the head's 56 px, the name cut beside both kinds and the actions", async () => {
  await withPage(true, 1440, async (page) => {
    const found = await shape(page);
    expect(found.height).toBe(56);
    expect(found.kinds).toEqual([found.name, found.name]);
    expect([found.avatar, ...found.actions]).toEqual([found.name, ...found.actions.map(() => found.name)]);
    expect(found.inside).toBe(true);
  });
});
