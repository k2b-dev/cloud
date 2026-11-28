import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-record-head.client";
import { measureV2Layout } from "./testing";

// A record's head on the phone (W8, Weather at 390 px with a long place name; W7, the Kundenakte with four symbols):
// avatar, name and the head's actions stand in one row, as the approved mockup's 57 px head. A name too long for one
// line takes a second (G7, the visitor head's mockup), and the head grows to 73 px; after it the name is cut with "…".
// The name comes before the kinds: it keeps at least 8ch; a kind without room beside it leaves the head, it never
// takes a row of its own. Before #4373, avatar, name and "…" took a row each (about 140 px), then the name shrank to
// 40 px beside the kinds. A place leads with its square mark instead of the round avatar. The fixture is
// test/v2-record-head.client.tsx.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss = "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; }";
const long = "Sankt Johann im Pongau an der Salzach im Salzburger Land";
// the worst case: one word wider than the line, after a few short ones
const unbroken = "Kulturhaus Donaudampfschifffahrtsgesellschaftskapitänswitwenrentenversicherung am Rhein";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-record-head.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

type Fixture = { kinds: boolean; width: number; name?: string; mark?: boolean; dark?: boolean };

const withPage = async (fixture: Fixture, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: fixture.width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"${fixture.dark ? ' class="dark"' : ""}><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({
      content: `window.__k2Kinds = ${fixture.kinds}; window.__k2Mark = ${fixture.mark === true}; window.__k2Name = ${JSON.stringify(fixture.name ?? long)};`,
    });
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
    const lead = bar.querySelector(":scope > .k2-bar-start > :is(.k2-av, .k2-mk)")!;
    const leadBox = lead.getBoundingClientRect();
    return {
      height: Math.round(bar.getBoundingClientRect().height),
      name: middle(name),
      lines: Math.round(name.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(name).lineHeight)),
      nameWidth: name.getBoundingClientRect().width,
      least: 8 * context.measureText("0").width,
      lead: middle(lead),
      leadShape: { kind: lead.classList.contains("k2-mk") ? "mark" : "avatar", width: leadBox.width, height: leadBox.height },
      leadRadius: getComputedStyle(lead).borderTopLeftRadius,
      actions: [...bar.querySelectorAll(":scope > .k2-bar-end .k2-btn")].map(middle),
      // the kinds that show, each on the name's row; none half cut at the start's edge
      kinds: chips.filter(shows).map(middle),
      halfCut: chips.filter((chip) => {
        const box = chip.getBoundingClientRect();
        return !shows(chip) && box.top < start.bottom - 0.5 && box.bottom > start.bottom + 0.5;
      }).length,
      // cut with "…": below the last line it shows, or beside its one line
      cut: name.scrollHeight > name.clientHeight + 0.5 || name.scrollWidth > name.clientWidth + 0.5,
      // nothing of the name runs out of its box sideways
      overflows: name.scrollWidth > name.clientWidth + 0.5 && getComputedStyle(name).whiteSpace !== "nowrap",
      inside: bar.getBoundingClientRect().right <= innerWidth + 0.5,
    };
  });

const aligned = (found: Awaited<ReturnType<typeof shape>>) =>
  expect([found.lead, ...found.actions, ...found.kinds]).toEqual([found.lead, ...found.actions, ...found.kinds].map(() => found.name));

test("390 px, a very long name with two kinds and four symbols: two lines in a head of 73 px, cut after them, at least 8ch, the kinds without room left out", async () => {
  await withPage({ kinds: true, width: 390 }, async (page) => {
    const found = await shape(page);
    expect([found.height, found.lines]).toEqual([73, 2]);
    expect(found.nameWidth).toBeGreaterThanOrEqual(found.least - 0.5);
    expect(found.actions).toHaveLength(4);
    aligned(found);
    expect([found.halfCut, found.cut, found.overflows, found.inside]).toEqual([0, true, false, true]);
  });
});

test("390 px, a very long name without kinds: the same two lines in 73 px", async () => {
  await withPage({ kinds: false, width: 390 }, async (page) => {
    const found = await shape(page);
    expect([found.height, found.lines]).toEqual([73, 2]);
    aligned(found);
    expect([found.cut, found.overflows, found.inside]).toEqual([true, false, true]);
  });
});

test("390 px, a short name: one row of 57 px, the kinds without room beside its 8ch left out", async () => {
  await withPage({ kinds: true, width: 390, name: "Ostbad" }, async (page) => {
    const found = await shape(page);
    expect([found.height, found.lines]).toEqual([57, 1]);
    aligned(found);
    expect([found.halfCut, found.cut, found.inside]).toEqual([0, false, true]);
  });
});

test("700 px, a short name with its kinds: one row of 57 px, the kinds beside the name on its middle", async () => {
  await withPage({ kinds: true, width: 700, name: "Ostbad" }, async (page) => {
    const found = await shape(page);
    expect([found.height, found.lines]).toEqual([57, 1]);
    expect(found.kinds).toHaveLength(2);
    aligned(found);
    expect([found.halfCut, found.cut, found.inside]).toEqual([0, false, true]);
  });
});

for (const dark of [false, true])
  test(`390 px, ${dark ? "dark" : "light"}, worst case: a place's square mark and one word wider than the line, two lines, nothing runs out, the layout clean`, async () => {
    await withPage({ kinds: true, width: 390, name: unbroken, mark: true, dark }, async (page) => {
      const found = await shape(page);
      expect([found.height, found.lines]).toEqual([73, 2]);
      expect(found.leadShape).toEqual({ kind: "mark", width: 32, height: 32 });
      expect(found.leadRadius).toBe("8px");
      aligned(found);
      expect([found.halfCut, found.overflows, found.inside]).toEqual([0, false, true]);
      const layout = await measureV2Layout(page);
      expect(layout.problems).toEqual([]);
    });
  });

test("1440 px, unchanged: the head's 56 px, the name on one line cut beside both kinds and the actions", async () => {
  await withPage({ kinds: true, width: 1440 }, async (page) => {
    const found = await shape(page);
    expect([found.height, found.lines]).toEqual([56, 1]);
    expect(found.kinds).toEqual([found.name, found.name]);
    expect(found.leadShape).toEqual({ kind: "avatar", width: 32, height: 32 });
    aligned(found);
    expect(found.inside).toBe(true);
  });
});

for (const dark of [false, true])
  test(`1440 px, ${dark ? "dark" : "light"}: a place's square mark of 32 px leads the head's one line, the layout clean`, async () => {
    await withPage({ kinds: false, width: 1440, name: unbroken, mark: true, dark }, async (page) => {
      const found = await shape(page);
      expect([found.height, found.lines]).toEqual([56, 1]);
      expect(found.leadShape).toEqual({ kind: "mark", width: 32, height: 32 });
      expect(found.leadRadius).toBe("8px");
      aligned(found);
      expect(found.inside).toBe(true);
      const layout = await measureV2Layout(page);
      expect(layout.problems).toEqual([]);
    });
  });
