import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-table-columns.client";

// Which column takes the room that is left, and a table wider than its pane (test/v2-table-columns.client.tsx, W3 in
// Spaces' admin): the text column grows, not the last one; a column named `grow` grows instead; a table that has to
// scroll sideways shows a cue at the edge it continues past and keeps its scrollbar.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-table-columns.client.tsx", "dom"), launchBrowser()]);
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

/** A table by its name: the width of each column, its cut cells, and how it scrolls sideways. */
const table = (label: string) => {
  const element = document.querySelector<HTMLElement>(`table[aria-label="${label}"]`)!;
  const scroll = element.closest<HTMLElement>(".k2-table-scroll")!;
  const heads = [...element.querySelectorAll<HTMLElement>("thead th")];
  const style = getComputedStyle(scroll);
  return {
    columns: Object.fromEntries(heads.map((head) => [head.textContent?.trim() ?? "", Math.round(head.getBoundingClientRect().width)])),
    // a cell cut inside its own column ends with "…"; none is cut without
    cut: [...element.querySelectorAll<HTMLElement>(".k2-cell-line")]
      .filter((line) => line.scrollWidth > line.clientWidth + 0.5 && getComputedStyle(line).textOverflow !== "ellipsis")
      .map((line) => line.textContent?.trim() ?? ""),
    scrolls: scroll.scrollWidth > scroll.clientWidth + 0.5,
    cue: { start: scroll.hasAttribute("data-more-start"), end: scroll.hasAttribute("data-more-end"), mask: style.maskImage !== "none" },
    bar: style.scrollbarWidth,
  };
};

for (const width of [1440, 1024])
  test(`at ${width} px the text column takes the room that is left, or the column named to grow`, async () => {
    await withPage(width, async (page) => {
      const areas = await page.evaluate(table, "Bereiche");
      // the last column keeps its width; the description takes the rest and shows more than its 250 px
      expect(areas.columns.Einstellungen).toBe(140);
      expect(areas.columns.Beschreibung).toBeGreaterThan(250);
      expect(areas.cut).toEqual([]);
      const members = await page.evaluate(table, "Mitglieder");
      // `grow` on the name: the note, the widest column, keeps its 300 px
      expect(members.columns.Notiz).toBe(300);
      expect(members.columns.Rolle).toBe(140);
      expect(members.columns.Name).toBeGreaterThan(220);
      // without `grow`: the column without a width grows; the widest that may drop does not
      const keys = await page.evaluate(table, "Schlüssel");
      expect(keys.columns.Name).toBe(200);
      expect(keys.columns.Präfix).toBeGreaterThan(200);
      if (width === 1440) expect(keys.columns["Zuletzt genutzt"]).toBe(320);
      const people = await page.evaluate(table, "Personen");
      expect(people.columns.Rolle).toBe(140);
      if (width === 1440) expect([people.columns["E-Mail"], people.columns.Name! > 200]).toEqual([300, true]);
    });
  });

test("at 1440 px a table with room scrolls not and shows no cue", async () => {
  await withPage(1440, async (page) => {
    const dates = await page.evaluate(table, "Termine");
    expect({ scrolls: dates.scrolls, cue: dates.cue, cut: dates.cut }).toEqual({
      scrolls: false,
      cue: { start: false, end: false, mask: false },
      cut: [],
    });
  });
});

test("at 1024 px a table wider than its pane scrolls sideways with a cue at its edges and its scrollbar", async () => {
  await withPage(1024, async (page) => {
    const dates = await page.evaluate(table, "Termine");
    expect({ scrolls: dates.scrolls, cue: dates.cue, cut: dates.cut }).toEqual({
      scrolls: true,
      cue: { start: false, end: true, mask: true },
      cut: [],
    });
    expect(dates.bar).not.toBe("none");
    // at its end the cue moves to the start
    await page.evaluate(() => {
      const scroll = document.querySelector('table[aria-label="Termine"]')!.closest<HTMLElement>(".k2-table-scroll")!;
      scroll.scrollLeft = scroll.scrollWidth;
    });
    await settled(page);
    expect((await page.evaluate(table, "Termine")).cue).toEqual({ start: true, end: false, mask: true });
  });
});

// A cell cut with "…" shows its whole text as a hint where the pointer rests on it (W2, Notebooks admin); a cell that
// is whole gets none. Its whole text stays in the page, so it stays the cell's name.
for (const width of [1440, 1024])
  test(`at ${width} px a cut cell shows its whole text as its hint, a whole one none`, async () => {
    await withPage(width, async (page) => {
      const note = "Vertritt die Werkstatt bei allen Terminen mit der Innung, der Handwerkskammer und den Lieferanten";
      const members = page.getByRole("table", { name: "Mitglieder" });
      const cut = members.locator(".k2-cell-line", { hasText: note });
      const whole = members.locator(".k2-cell-line", { hasText: "Lager und Inventur" });
      expect(await cut.evaluate((line) => line.scrollWidth > line.clientWidth)).toBe(true);
      await cut.hover();
      await whole.hover();
      expect([await cut.getAttribute("title"), await whole.getAttribute("title")]).toEqual([note, null]);
      expect(await cut.textContent()).toBe(note);
    });
  });
