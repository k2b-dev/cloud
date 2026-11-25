import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-status-table.client";
import { textEdge } from "./tokens";

// A filtered list as an operations log draws it (test/v2-status-table.client.tsx): the status row measures its own
// column, drops its key figures below 760 px so the order controls keep their words, and holds a place for its loading
// mark; the large table with a sticky first column starts body, head and group rows on one text edge; a phone row ends
// in the state of its entry.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0 auto 0 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-status-table.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** Opens the fixture in a window of `width`; the column (the root) is `column` wide, so it narrows without the window. */
const withPage = async (run: (page: Page) => Promise<void>, { width = 1440, column = width }: { width?: number; column?: number } = {}) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root" style="width: ${column}px"></div></body></html>`,
    );
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    // the column is the width of its rows: the frame of the workspace around them takes its own pixels
    await page.evaluate((wanted) => {
      const root = document.getElementById("root")!;
      const pane = document.querySelector(".k2-pane")!;
      root.style.width = `${wanted + wanted - pane.getBoundingClientRect().width}px`;
    }, column);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** The status row: its width, whether its figures show, and whether lead and controls stay whole within its edge. */
const statusRow = () => {
  const row = document.querySelector('[data-k2-part="StatusRow"]')!;
  const box = row.getBoundingClientRect();
  const end = box.right - Number.parseFloat(getComputedStyle(row).paddingRight);
  const lead = row.querySelector(".k2-status-lead")!.getBoundingClientRect();
  const controls = [...row.querySelectorAll<HTMLElement>(".k2-bar-end .k2-btn")];
  return {
    width: Math.round(box.width * 64) / 64,
    facts: [...row.querySelectorAll(".k2-fact")].filter((fact) => fact.getClientRects().length > 0).length,
    controls: controls.map((button) => ({
      name: button.textContent?.trim(),
      inside: button.getBoundingClientRect().right <= end + 0.5,
      whole: button.scrollWidth <= button.clientWidth,
      clear: button.getBoundingClientRect().left >= lead.right,
    })),
  };
};

for (const column of [1024, 760, 759.5, 759, 600])
  test(`a status row ${column} px wide: figures from 760 px on, below they give way and the controls keep their words`, async () => {
    await withPage(
      async (page) => {
        const found = await page.evaluate(statusRow);
        expect(found.width).toBe(column);
        expect(found.facts).toBe(column >= 760 ? 2 : 0);
        for (const control of found.controls) expect(control).toEqual({ name: control.name, inside: true, whole: true, clear: true });
        expect(found.controls.map((control) => control.name)).toEqual(["Neueste zuerst", "Nach Minute"]);
      },
      { column },
    );
  });

for (const width of [1440, 390])
  test(`at ${width}: the loading mark has its place of 16 px whether it shows or not, and nothing moves`, async () => {
    await withPage(
      async (page) => {
        const place = () => {
          const row = document.querySelector('[data-k2-part="StatusRow"]')!;
          const mark = row.querySelector<HTMLElement>(".k2-status-busy")!;
          const box = mark.getBoundingClientRect();
          return {
            mark: [Math.round(box.width), Math.round(box.height)],
            spinning: mark.querySelector(".k2-icon")?.getClientRects().length ?? 0,
            said: mark.textContent?.trim() ?? "",
            role: mark.getAttribute("role"),
            parts: [...row.querySelectorAll(".k2-status-lead, .k2-status-busy, .k2-fact:not([hidden]), .k2-bar-end")].map((part) =>
              Math.round(part.getBoundingClientRect().left),
            ),
            row: Math.round(row.getBoundingClientRect().height),
          };
        };
        const idle = await page.evaluate(place);
        expect(idle.mark).toEqual([16, 16]);
        expect(idle.spinning).toBe(0);
        expect(idle.said).toBe("");
        expect(idle.role).toBe("status");
        await page.evaluate(() => window.__k2Loading?.(true));
        await settled(page);
        const busy = await page.evaluate(place);
        expect(busy.spinning).toBe(1);
        expect(busy.said).toBe("Wird geladen...");
        expect({ ...busy, spinning: 0, said: "" }).toEqual(idle);
        // the mark follows the lead's words at the gap of the row
        expect(busy.parts[1]! - busy.parts[0]!).toBeGreaterThan(0);
      },
      { width },
    );
  });

for (const column of [1440, 1024, 700])
  test(`a sticky table ${column} px wide starts body, head and group rows on one text edge and ends them on one`, async () => {
    await withPage(
      async (page) => {
        const edges = await page.evaluate(() => {
          const table = document.querySelector<HTMLElement>(".k2-table[data-grid]")!;
          const scroller = table.parentElement!.getBoundingClientRect();
          const textLeft = (cell: Element) => {
            const range = document.createRange();
            range.selectNodeContents(cell.querySelector(".k2-cell-line, .k2-group-row") ?? cell);
            return Math.round(range.getBoundingClientRect().left - scroller.left);
          };
          const textRight = (cell: Element) =>
            Math.round(cell.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(cell).paddingRight) - scroller.left);
          const head = table.querySelectorAll("thead th");
          const body = table.querySelector("tbody tr:not([data-group])")!.children;
          const group = table.querySelector("tbody tr[data-group] > td")!;
          return {
            start: { head: textLeft(head[0]!), body: textLeft(body[0]!), group: textLeft(group) },
            end: { head: textRight(head[head.length - 1]!), body: textRight(body[body.length - 1]!) },
          };
        });
        expect(edges.start).toEqual({ head: textEdge.wide, body: textEdge.wide, group: textEdge.wide });
        expect(edges.end.body).toBe(edges.end.head);
      },
      { column },
    );
  });

test("390 px: the search of the head stays as its symbol, opens over the head while it has the focus, and folds back", async () => {
  await withPage(
    async (page) => {
      const search = page.getByRole("searchbox", { name: "Durchsuchen" });
      const shape = () =>
        page.evaluate(() => {
          const bar = document.querySelector('[data-slot="head"] > .k2-bar')!.getBoundingClientRect();
          const field = document.querySelector<HTMLElement>('[data-slot="head"] .k2-input[data-search]')!.getBoundingClientRect();
          const more = document.querySelector('[data-slot="head"] .k2-btn[aria-label="Weitere Aktionen"]')!.getBoundingClientRect();
          return {
            size: [Math.round(field.width), Math.round(field.height)],
            left: Math.round(field.left - bar.left),
            right: Math.round(bar.right - field.right),
            middle: Math.abs(Math.round(field.top + field.height / 2 - (bar.top + bar.height / 2))),
            beforeMore: field.right <= more.left,
          };
        });
      const folded = await shape();
      expect(folded).toEqual({ size: [36, 36], left: folded.left, right: folded.right, middle: 0, beforeMore: true });
      // a tap on the symbol is a tap into the field
      await page.mouse.click(folded.left + 18, (await page.locator('[data-slot="head"] > .k2-bar').boundingBox())!.y + 28);
      await settled(page);
      expect(await search.evaluate((input) => document.activeElement === input)).toBe(true);
      const open = await shape();
      expect({ left: open.left, right: open.right, height: open.size[1], middle: open.middle }).toEqual({
        left: textEdge.phone,
        right: textEdge.phone,
        height: 36,
        middle: 0,
      });
      await search.fill("Zeitüberschreitung");
      await search.blur();
      await settled(page);
      expect(await shape()).toEqual(folded);
      expect(await search.inputValue()).toBe("Zeitüberschreitung");
    },
    { width: 390 },
  );
});

test("390 px: Escape folds the open search of the head back and keeps its words, unless the app takes Escape", async () => {
  await withPage(
    async (page) => {
      const search = page.getByRole("searchbox", { name: "Durchsuchen" });
      const width = () =>
        page.evaluate(() => Math.round(document.querySelector('[data-slot="head"] .k2-input[data-search]')!.getBoundingClientRect().width));
      await search.focus();
      await page.keyboard.type("Zeitüberschreitung");
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await search.evaluate((input) => document.activeElement === input)).toBe(false);
      expect(await search.inputValue()).toBe("Zeitüberschreitung");
      expect(await width()).toBe(36);
      // an app that takes Escape itself (onKeyDown with preventDefault) decides alone: the field stays open
      await page.evaluate(() => {
        window.__k2TakeEscape = true;
      });
      await search.focus();
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await search.evaluate((input) => document.activeElement === input)).toBe(true);
      expect(await page.evaluate(() => window.__k2Escapes)).toBe(1);
      expect(await search.inputValue()).toBe("Zeitüberschreitung");
      expect(await width()).toBeGreaterThan(300);
    },
    { width: 390 },
  );
});

test("1440 px: Escape in the search of the head is the browser's and the app's, the field is not folded", async () => {
  await withPage(async (page) => {
    const search = page.getByRole("searchbox", { name: "Durchsuchen" });
    await search.focus();
    await page.keyboard.type("mail");
    await page.keyboard.press("Escape");
    await settled(page);
    expect(await search.evaluate((input) => document.activeElement === input)).toBe(true);
  });
});

test("1440 px: the search of the head is its field of 184 px", async () => {
  await withPage(async (page) => {
    const width = await page.evaluate(() =>
      Math.round(document.querySelector('[data-slot="head"] .k2-input[data-search]')!.getBoundingClientRect().width),
    );
    expect(width).toBe(184);
  });
});

test("390 px: a phone row of the table ends in the state of its entry, at the end of its second line", async () => {
  await withPage(
    async (page) => {
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".k2-table-phone .k2-row")].map((row) => {
          const box = row.getBoundingClientRect();
          const end = box.right - Number.parseFloat(getComputedStyle(row).paddingRight);
          const chip = row.querySelector(".k2-row-marks .k2-chip")?.getBoundingClientRect();
          const second = row.querySelector(".k2-row-l2")!.getBoundingClientRect();
          const time = row.querySelector(".k2-row-time")!.getBoundingClientRect();
          return {
            state: row.querySelector(".k2-row-marks")?.textContent?.trim(),
            atEnd: chip !== undefined && Math.abs(chip.right - end) < 0.5,
            onSecondLine:
              chip !== undefined &&
              chip.top >= time.bottom - 0.5 &&
              Math.abs((chip.top + chip.bottom) / 2 - (second.top + second.bottom) / 2) < 3,
            besideText: chip !== undefined && chip.left >= second.right,
          };
        }),
      );
      expect(rows.map((row) => row.state)).toEqual(["Fehler", "Fehler", "Warnung", "Warnung"]);
      for (const row of rows) expect(row).toEqual({ state: row.state, atEnd: true, onSecondLine: true, besideText: true });
    },
    { width: 390 },
  );
});
