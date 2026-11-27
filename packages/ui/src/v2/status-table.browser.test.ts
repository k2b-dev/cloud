import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-status-table.client";
import { describeV2Page, measureV2Layout } from "./testing";
import { textEdge } from "./tokens";

// A filtered list as an operations log draws it (test/v2-status-table.client.tsx): the status row measures its own
// column, lets its key figures and then its lead give way so the order controls keep their words, folds those controls
// to their symbols below 600 px, and holds a place for its loading mark; the large table with a sticky first column
// starts body, head and group rows on one text edge; a phone row ends in the state of its entry.

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

/**
 * Opens the fixture in a window of `width`; the column (the root) is `column` wide, so it narrows without the window.
 * `host` marks the v2 scope as a host's that offers the page's search in a bar of its own (`data-k2-host-search`);
 * `path` gives the head a `Path` instead of its views.
 */
const withPage = async (
  run: (page: Page) => Promise<void>,
  {
    width = 1440,
    column = width,
    host = false,
    path = false,
    bare = false,
  }: { width?: number; column?: number; host?: boolean; path?: boolean; bare?: boolean } = {},
) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"${host ? " data-k2-host-search" : ""}><div id="root" style="width: ${column}px"></div></body></html>`,
    );
    if (path)
      await page.evaluate(() => {
        window.__k2PathHead = true;
      });
    if (bare)
      await page.evaluate(() => {
        window.__k2BareHead = true;
      });
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

/**
 * The status row: its width, which figures are in sight and whether each is whole and clear of the end, the gaps
 * before them, and whether its controls stay whole within its edge. Self-contained (Playwright sends its source).
 */
const statusRow = () => {
  const row = document.querySelector('[data-k2-part="StatusRow"]')!;
  const box = row.getBoundingClientRect();
  const inner = box.right - Number.parseFloat(getComputedStyle(row).paddingRight);
  const end = row.querySelector(".k2-bar-end")?.getBoundingClientRect().left ?? inner;
  const lead = row.querySelector(".k2-status-lead")!.getBoundingClientRect();
  const figures = [...row.querySelectorAll<HTMLElement>(".k2-fact")].map((fact) => {
    const shape = fact.getBoundingClientRect();
    // what of the figure is in sight: within every box between it and the row that clips what overflows it
    let [left, right, top, bottom] = [shape.left, shape.right, shape.top, shape.bottom];
    for (let parent = fact.parentElement; parent && parent !== row.parentElement; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflow === "visible") continue;
      const clip = parent.getBoundingClientRect();
      [left, right, top, bottom] = [
        Math.max(left, clip.left),
        Math.min(right, clip.right),
        Math.max(top, clip.top),
        Math.min(bottom, clip.bottom),
      ];
    }
    return {
      shape,
      seen: fact.getClientRects().length > 0 && right - left > 0.5 && bottom - top > 0.5,
      whole: right - left >= shape.width - 0.5 && bottom - top >= shape.height - 0.5,
      clear: shape.right <= end,
    };
  });
  const seen = figures.filter((figure) => figure.seen);
  const before = row.querySelector(".k2-status-busy")?.getBoundingClientRect() ?? lead;
  return {
    width: Math.round(box.width * 64) / 64,
    shown: figures.map((figure) => figure.seen),
    wrong: seen.filter((figure) => !(figure.whole && figure.clear)).length,
    gaps: [before, ...seen.map((figure) => figure.shape)].flatMap((shape, index, shapes) =>
      index === 0 ? [] : [Math.round(shape.left - shapes[index - 1]!.right)],
    ),
    // the buttons and the switches at the end (a switch is a `Check` in a `.k2-choice`)
    controls: [...row.querySelectorAll<HTMLElement>(".k2-bar-end :is(.k2-btn, .k2-choice)")].map((button) => ({
      name: button.textContent?.trim(),
      inside: button.getBoundingClientRect().right <= inner + 0.5,
      whole: button.scrollWidth <= button.clientWidth,
      clear: button.getBoundingClientRect().left >= lead.right,
    })),
    /** The lead: whether its words are cut, and whether a cut ends in "…" instead of running on. */
    lead: (() => {
      const element = row.querySelector<HTMLElement>(".k2-status-lead")!;
      const style = getComputedStyle(element);
      return {
        cut: element.scrollWidth > element.clientWidth + 0.5,
        ellipsis: style.textOverflow === "ellipsis" && style.overflow === "hidden",
        // a cut lead keeps about a word (4.5 em) or all of it, never a letter and "…"
        word: element.clientWidth >= Math.min(4.5 * Number.parseFloat(style.fontSize), element.scrollWidth) - 0.5,
      };
    })(),
    /** The words of each control in sight (a folded control keeps them only as its name). */
    words: [...row.querySelectorAll<HTMLElement>(".k2-bar-end .k2-btn")].map((button) => {
      const label = button.querySelector(".k2-btn-label")?.getBoundingClientRect();
      return label !== undefined && label.width > 1 && label.height > 1;
    }),
  };
};

/**
 * The figures in sight are whole, clear of the controls, the first ones, 16 px apart; the controls stay whole within
 * the row and clear of the lead; a lead that does not fit is cut with "…".
 */
const expectHeld = (found: Awaited<ReturnType<typeof statusRow>>, word = true) => {
  expect(found.wrong).toBe(0);
  expect(found.shown).toEqual(found.shown.map((_, index) => index < found.shown.filter(Boolean).length));
  for (const gap of found.gaps) expect(gap).toBe(16);
  for (const control of found.controls) expect(control).toEqual({ name: control.name, inside: true, whole: true, clear: true });
  if (found.lead.cut) expect(found.lead).toEqual({ cut: true, ellipsis: true, word: word ? true : found.lead.word });
};

// Figures give way only where they do not fit before the controls, never by the row's width alone (#4149).
for (const column of [1024, 760, 600, 400])
  test(`a status row ${column} px wide: the figures that fit stay, the controls keep their words`, async () => {
    await withPage(
      async (page) => {
        const found = await page.evaluate(statusRow);
        expect(found.width).toBe(column);
        expectHeld(found);
        if (column >= 760) expect(found.shown).toEqual([true, true]);
        expect(found.controls.map((control) => control.name)).toEqual(["Neueste zuerst", "Nach Minute"]);
      },
      { column },
    );
  });

// More figures than fit before the controls: the later ones go first, whole; none is cut or runs under a control.
for (const column of [1440, 1024, 900, 760, 400])
  test(`a status row ${column} px wide with more figures than fit: whole figures from the first on, none under a control`, async () => {
    await withPage(
      async (page) => {
        await page.evaluate(() => window.__k2MoreFacts?.());
        await settled(page);
        const found = await page.evaluate(statusRow);
        expectHeld(found);
        if (column >= 1024) expect(found.shown.filter(Boolean).length).toBeGreaterThan(1);
      },
      { column },
    );
  });

// A lead and worded controls that do not fit beside each other: the lead is cut with "…" first, the controls keep
// their words; below 600 px the controls keep only their symbols and the words stay their names (#4166).
for (const long of [false, true])
  for (const column of [760, 600, 400, 320])
    test(`a status row ${column} px wide with a ${long ? "long" : "short"} lead: lead and controls never overlap`, async () => {
      await withPage(
        async (page) => {
          if (long) await page.evaluate(() => window.__k2LongLead?.());
          await settled(page);
          const found = await page.evaluate(statusRow);
          expect(found.width).toBe(column);
          expectHeld(found);
          const folded = column <= 600;
          expect(found.words).toEqual([!folded, !folded]);
          if (long && !folded) expect(found.lead.cut).toBe(true);
          for (const name of ["Neueste zuerst", "Nach Minute"])
            expect(await page.getByRole("button", { name, exact: true }).isVisible()).toBe(true);
        },
        { column },
      );
    });

// The operations log (break-ui finding 21): large counts, live as a toggle with a symbol and the short label "Live",
// and sort and grouping as framed menus in words. Live is on, or blocked (until now, first page): then the toggle is
// disabled and the reason is a figure. At every width, also the narrow list column beside an open entry, the figures
// give way before they reach a control, the lead keeps about a word and is cut before a control, and no control is cut
// or pushed past the row's edge. In a window of 1024 px, where the finding was seen, the list column is about 760 px
// beside the sidebar and 520 px with an entry open.
for (const live of ["on", "until-now", "first-page"] as const)
  for (const [width, column] of [
    [1440, 1440],
    [1440, 1024],
    [1024, 760],
    [1024, 520],
    [1440, 600],
    [1440, 400],
    [1440, 320],
  ] as const)
    test(`a status row ${column} px wide in a window of ${width} px as the operations log draws it, live ${live}: nothing overlaps`, async () => {
      await withPage(
        async (page) => {
          await page.evaluate((state) => window.__k2Logs?.(state), live);
          await settled(page);
          const found = await page.evaluate(statusRow);
          expect(found.width).toBe(column);
          // at 320 px three folded controls (two of them menus with their chevron) leave the lead less than a word
          expectHeld(found, column > 320);
          expect(found.controls.map((control) => control.name)).toEqual(["Live", "Eingang ↓", "Keine Gruppen"]);
          expect(found.words).toEqual(column <= 600 ? [false, false, false] : [true, true, true]);
          // where they fit beside the lead, every figure stays, also the reason live is blocked; at 1024 px the reason
          // does not fit beside the whole lead and the counts, and only it gives way
          if (column >= 1440) expect(found.shown.every(Boolean)).toBe(true);
          if (column === 1024) expect(found.shown.slice(0, 2)).toEqual([true, true]);
          const toggle = page.getByRole("button", { name: "Live", exact: true });
          expect(await toggle.isDisabled()).toBe(live !== "on");
          expect(await toggle.getAttribute("aria-pressed")).toBe(live === "on" ? "true" : "false");
        },
        { width, column },
      );
    });

// A list with an entry open beside it (proxy-auth, ipa-hosts; design review 26.11.): the narrower list column cuts the
// long lead with "…" before the chip at its end, never mid-word under the chip, and the whole statement stays as a hint
// on hover. measureV2Layout reports nothing cut in the row.
for (const width of [1440, 1024])
  test(`a list with an entry open in a window of ${width} px: the lead ends in "…" before the chip and keeps its words as hint`, async () => {
    await withPage(
      async (page) => {
        await page.evaluate(() => window.__k2Proxy?.());
        await settled(page);
        const found = await page.evaluate(() => {
          const row = document.querySelector('[data-k2-part="StatusRow"]')!;
          const lead = row.querySelector<HTMLElement>(".k2-status-lead")!;
          const chip = row.querySelector(".k2-bar-end .k2-chip")!.getBoundingClientRect();
          const style = getComputedStyle(lead);
          return {
            detail: document.querySelector(".k2-pane[data-detail]") !== null,
            cut: lead.scrollWidth > lead.clientWidth + 0.5,
            ellipsis: style.textOverflow === "ellipsis" && style.overflow === "hidden",
            clear: lead.getBoundingClientRect().right <= chip.left,
            title: lead.title,
          };
        });
        // at 1440 the list beside the entry holds the whole lead; at 1024 it is cut with "…"
        expect(found).toEqual({
          detail: true,
          cut: width === 1024,
          ellipsis: true,
          clear: true,
          title: "1 Client ist bis zur Konfiguration gesperrt",
        });
        expect((await measureV2Layout(page, { root: '[data-k2-part="StatusRow"]' })).cut).toEqual([]);
      },
      { width },
    );
  });

// The order of giving way (Tools, U3): the lead and the figures share the room before the filters, each up to its own
// width. In rows of 1440 and 1024 px the figures keep their width and only the lead gives way (cut with "…" at 1024 px);
// in a row of 700 px both are long for their part: the lead is cut and keeps 40 %, the later figures fold; below 600 px
// (560), where the controls fold, the lead keeps 60 %. On the phone the figures and filters leave and the lead takes
// the row.
for (const [width, column] of [
  [1440, 1440],
  [1440, 1024],
  [1440, 700],
  [1440, 560],
  [390, 390],
] as const)
  test(`a row of ${column} px, a long lead, three figures and filters: the lead gives way first, then the figures`, async () => {
    await withPage(
      async (page) => {
        await page.evaluate(() => {
          window.__k2LongLead?.();
          window.__k2ThreeFacts?.();
        });
        await settled(page);
        const found = await page.evaluate(statusRow);
        if (width < 768) {
          // on the phone the figures and filters have left, so only the lead is measured there
          expect(found.lead).toEqual({ cut: true, ellipsis: true, word: true });
          return;
        }
        expectHeld(found);
        const room = await page.evaluate(() => {
          const row = document.querySelector('[data-k2-part="StatusRow"]')!;
          return {
            lead: row.querySelector(".k2-status-lead")!.getBoundingClientRect().width,
            facts: row.querySelector(".k2-status-facts")!.getBoundingClientRect().width,
          };
        });
        // the lead gives way first: every figure keeps its width, the lead is what is cut
        if (column >= 1024) expect(found.shown).toEqual([true, true, true]);
        if (column === 1024) expect(found.lead.cut).toBe(true);
        if (column === 700) {
          // then the figures: the lead is cut and keeps its 40 %, the later figures fold
          expect(found.lead.cut).toBe(true);
          expect(found.shown[0]).toBe(true);
          expect(found.shown.filter(Boolean).length).toBeLessThan(3);
          expect(Math.abs(room.lead / (room.lead + room.facts) - 0.4)).toBeLessThanOrEqual(0.02);
        }
        if (column === 560) {
          // below 600 px, where the controls fold, the lead keeps 60 % (about a word beside them)
          expect(found.lead.cut).toBe(true);
          expect(found.shown.filter(Boolean).length).toBeLessThan(3);
          expect(Math.abs(room.lead / (room.lead + room.facts) - 0.6)).toBeLessThanOrEqual(0.02);
        }
      },
      { width, column },
    );
  });

// Mail's list column (a select box, a short lead, one long figure, no filters): beside the short lead the figure takes
// all the rest of the row (Opus review of #4259: a cap on the figures hid it). At 432 px the figure is longer than that
// rest where the type is wide, and folds whole; at 520 px it fits and stays in sight.
for (const column of [432, 520])
  test(`a status row ${column} px wide as Mail's list draws it gives its one long figure all the rest`, async () => {
    await withPage(
      async (page) => {
        await page.evaluate(() => window.__k2MailFact?.());
        await settled(page);
        const found = await page.evaluate(statusRow);
        expect(found.width).toBe(column);
        expectHeld(found);
        expect(found.lead.cut).toBe(false);
        // the figures reach the end of the row's start: they take the rest, no cap
        const rest = await page.evaluate(() => {
          const row = document.querySelector('[data-k2-part="StatusRow"]')!;
          return (
            row.querySelector(".k2-bar-start")!.getBoundingClientRect().right -
            row.querySelector(".k2-status-facts")!.getBoundingClientRect().right
          );
        });
        // at 432 px the figure is in sight where the engine's type lets it fit, else it was given all the rest
        if (column === 432) expect(found.shown[0] || rest <= 2).toBe(true);
        if (column === 520) expect(found.shown).toEqual([true]);
      },
      { column },
    );
  });

/**
 * The chips of a status row's statement and its lead: each chip in sight whole or not at all, after the lead and clear
 * of the controls; whether the lead keeps about a word (4.5 em, or all of it); and whether the lead stands at that
 * floor, as it does when the chips have given way. Self-contained (Playwright sends its source).
 */
const statusMarks = () => {
  const row = document.querySelector('[data-k2-part="StatusRow"]')!;
  const lead = row.querySelector<HTMLElement>(".k2-status-lead")!;
  const group = row.querySelector(".k2-status-marks")!.getBoundingClientRect();
  const end = row.querySelector(".k2-bar-end");
  const endLeft = end && getComputedStyle(end).display !== "none" ? end.getBoundingClientRect().left : Number.POSITIVE_INFINITY;
  const style = getComputedStyle(lead);
  const floor = Math.min(4.5 * Number.parseFloat(style.fontSize), lead.scrollWidth);
  return {
    chips: [...row.querySelectorAll<HTMLElement>(".k2-status-marks .k2-chip")].map((chip) => {
      const box = chip.getBoundingClientRect();
      const inside =
        box.left >= group.left - 0.5 && box.right <= group.right + 0.5 && box.top >= group.top - 0.5 && box.bottom <= group.bottom + 0.5;
      const outside = box.top >= group.bottom - 0.5 || box.left >= group.right - 0.5;
      return {
        name: chip.textContent?.trim(),
        seen: inside,
        whole: inside || outside,
        clear: !inside || (box.left >= lead.getBoundingClientRect().right && box.right <= endLeft),
      };
    }),
    lead: {
      cut: lead.scrollWidth > lead.clientWidth + 0.5,
      ellipsis: style.textOverflow === "ellipsis" && style.overflow === "hidden",
      word: lead.clientWidth >= floor - 0.5,
      atFloor: Math.abs(lead.getBoundingClientRect().width - floor) <= 1,
    },
  };
};

/** Every chip whole or not at all, the first ones stay, none under the lead or a control; the lead keeps a word. */
const expectMarksHeld = (found: ReturnType<typeof statusMarks>) => {
  expect(found.chips.map((chip) => chip.name)).toEqual(["1 ohne Zugriff", "2 laufen ab"]);
  for (const chip of found.chips) expect({ ...chip, seen: true }).toEqual({ name: chip.name, seen: true, whole: true, clear: true });
  const seen = found.chips.map((chip) => chip.seen);
  expect(seen).toEqual(seen.map((_, index) => index < seen.filter(Boolean).length));
  // about a word of the lead stays beside the chips, at every width
  expect(found.lead.word).toBe(true);
  if (found.lead.cut) expect(found.lead.ellipsis).toBe(true);
  // the chips are what gives way: a chip leaves only where the lead stands at its floor
  if (seen.includes(false)) expect(found.lead.atFloor).toBe(true);
};

// Tinted chips of the statement (W2, Notebooks admin; rule 2): an exception "1 ohne Zugriff" stands as a red chip after
// the lead, also on the phone, beside a long lead, figures and the filters. Both chips are in sight at 1440 px and on the
// phone at 390 px; in a desktop row of 320 px beside two folded controls a chip gives way, whole, and the lead keeps
// about a word.
for (const [width, column] of [
  [1440, 1440],
  [390, 390],
  [1440, 320],
] as const)
  test(`a row of ${column} px in a window of ${width} px: the statement carries its tinted chips, whole or not at all`, async () => {
    await withPage(
      async (page) => {
        await page.evaluate(() => {
          window.__k2LongLead?.();
          window.__k2Marks?.();
        });
        await settled(page);
        const found = await page.evaluate(statusMarks);
        expectMarksHeld(found);
        const seen = found.chips.map((chip) => chip.seen);
        if (column === 1440 || width < 768) expect(seen).toEqual([true, true]);
        if (column === 320) expect(seen.includes(false)).toBe(true);
        // the outline names the chips a person sees, not one that gave way
        const outline = await describeV2Page(page);
        for (const chip of found.chips) expect(outline.includes(`"${chip.name}"]`)).toBe(chip.seen);
      },
      { width, column },
    );
  });

// Just above and below the points where a chip gives way: rows from 480 down to 320 px in steps of 20. At each width the
// rule holds; as the row narrows the chips in sight only get fewer, and both steps (two to one, one to none or a chip
// less) happen in this span, so the series passes over the threshold rather than beside it.
test("rows from 480 to 320 px: the chips give way one by one, whole, and the lead keeps about a word at every step", async () => {
  const counts: number[] = [];
  for (const column of [480, 460, 440, 420, 400, 380, 360, 340, 320])
    await withPage(
      async (page) => {
        await page.evaluate(() => {
          window.__k2LongLead?.();
          window.__k2Marks?.();
        });
        await settled(page);
        const found = await page.evaluate(statusMarks);
        expectMarksHeld(found);
        counts.push(found.chips.filter((chip) => chip.seen).length);
      },
      { column },
    );
  // never more chips in a narrower row, and the series crosses a threshold
  expect(counts).toEqual([...counts].sort((a, b) => b - a));
  expect(new Set(counts).size).toBeGreaterThan(1);
}, 60_000);

// `marks={missing() > 0 && <Chip …/>}` passes `false` while nothing is missing: the row is then the row without chips,
// no empty group, the same lead and figures, so nothing moves when the exception comes or goes (Opus review of #4259).
test("a row of 1024 px with marks={false} is the row without marks: no empty group, the same lead and figures", async () => {
  const measure = async (state?: "none") =>
    withPage(
      async (page) => {
        await page.evaluate((marks) => {
          window.__k2LongLead?.();
          window.__k2ThreeFacts?.();
          if (marks) window.__k2Marks?.(marks);
        }, state);
        await settled(page);
        const found = await page.evaluate(() => {
          const row = document.querySelector('[data-k2-part="StatusRow"]')!;
          const width = (selector: string) => Math.round((row.querySelector(selector)?.getBoundingClientRect().width ?? -1) * 10) / 10;
          return {
            group: row.querySelector(".k2-status-marks") !== null,
            lead: width(".k2-status-lead"),
            facts: width(".k2-status-facts"),
          };
        });
        results.push(found);
      },
      { column: 1024 },
    );
  const results: { group: boolean; lead: number; facts: number }[] = [];
  await measure();
  await measure("none");
  expect(results[1]).toEqual(results[0]!);
  expect(results[1]!.group).toBe(false);
});

// A row with nothing at its end keeps its figures where they fit, as in Mail's list column of 432 px.
test("a status row 432 px wide without filters keeps its figures", async () => {
  await withPage(
    async (page) => {
      await page.evaluate(() => window.__k2NoFilters?.());
      await settled(page);
      const found = await page.evaluate(statusRow);
      expect(found.width).toBe(432);
      expectHeld(found);
      expect(found.shown).toEqual([true, true]);
    },
    { column: 432 },
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
      // the open field covers the views and draws no line of its own: the head keeps its one line
      expect((await measureV2Layout(page, { root: '[data-slot="head"] > .k2-bar' })).problems).toEqual([]);
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

// The Cloud shell offers the page's search in its phone bar (as the mockup draws Mail): the head keeps its tabs, and the
// field opens over the head when the host focuses it.
test("390 px in a host's bar: the folded search leaves the head to its tabs, opens over the head on focus, Escape folds it away", async () => {
  await withPage(
    async (page) => {
      const search = page.getByRole("searchbox", { name: "Durchsuchen" });
      const state = () =>
        page.evaluate(() => {
          const bar = document.querySelector('[data-slot="head"] > .k2-bar')!.getBoundingClientRect();
          const field = document.querySelector('[data-slot="head"] .k2-input[data-search]')!.getBoundingClientRect();
          const tabs = [...document.querySelectorAll<HTMLElement>('[data-slot="head"] .k2-tabs > .k2-tab')]
            .filter((tab) => tab.getClientRects().length > 0 && getComputedStyle(tab).visibility !== "hidden")
            .map((tab) => tab.firstChild?.textContent ?? "");
          const menu = document.querySelector('[data-slot="head"] .k2-tabs-nav > :not(.k2-tabs)')?.textContent?.trim();
          return { tabs, menu, field: [Math.round(field.width), Math.round(field.left - bar.left), Math.round(bar.right - field.right)] };
        });
      const folded = await state();
      // every view keeps its tab beside the menu of further views; none joins that menu for the search's sake
      expect([folded.tabs, folded.menu]).toEqual([["Alle", "Fehler", "Warn"], "Weitere+2"]);
      expect(folded.field[0]).toBeLessThanOrEqual(1);
      // the host focuses the field (the shell's phone bar does it on a tap): it opens over the head
      await search.focus();
      await settled(page);
      expect((await state()).field).toEqual([390 - 2 * textEdge.phone, textEdge.phone, textEdge.phone]);
      await page.keyboard.type("Zeitüberschreitung");
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await search.evaluate((input) => document.activeElement === input)).toBe(false);
      expect(await search.inputValue()).toBe("Zeitüberschreitung");
      expect(await state()).toEqual(folded);
    },
    { width: 390, host: true },
  );
});

// The host's bar is the one way into the folded search: the Tab key passes it by, the host's focus still reaches it.
test("390 px in a host's bar: the folded search is out of the Tab key's order, and the host still focuses it", async () => {
  await withPage(
    async (page) => {
      const search = page.getByRole("searchbox", { name: "Durchsuchen" });
      expect(await search.evaluate((input) => input.tabIndex)).toBe(-1);
      const reached: string[] = [];
      for (let step = 0; step < 8; step += 1) {
        await page.keyboard.press("Tab");
        reached.push(
          await page.evaluate(
            () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim() ?? "",
          ),
        );
      }
      expect(reached).not.toContain("Durchsuchen");
      await search.focus();
      expect(await search.evaluate((input) => document.activeElement === input)).toBe(true);
    },
    { width: 390, host: true },
  );
});

test("1440 px in a host's page: the search of the head stays in the Tab key's order", async () => {
  await withPage(
    async (page) => {
      expect(await page.getByRole("searchbox", { name: "Durchsuchen" }).evaluate((input) => input.tabIndex)).toBe(0);
    },
    { host: true },
  );
});

// A head with a path and nothing else but its search gives way on the phone; its search opens over the content's first
// row, so nothing below moves. (A head that also holds a menu "…" keeps its height: phone-head-actions.browser.test.ts.)
test("390 px in a host's bar with a path: the search opens over the status row and nothing below the head moves", async () => {
  await withPage(
    async (page) => {
      const search = page.getByRole("searchbox", { name: "Durchsuchen" });
      const state = () =>
        page.evaluate(() => {
          const head = document.querySelector('[data-slot="head"] > .k2-bar')!.getBoundingClientRect();
          const status = document.querySelector('[data-k2-part="StatusRow"]')!.getBoundingClientRect();
          const field = document.querySelector('[data-slot="head"] .k2-input[data-search]')!.getBoundingClientRect();
          const hit = document.elementFromPoint(field.left + field.width / 2, field.top + field.height / 2);
          return {
            head: Math.round(head.height),
            status: Math.round(status.top),
            field: [Math.round(field.width), Math.round(field.left), Math.round(field.top - status.top)],
            onTop: hit?.closest('[data-k2-part="Input"]') !== null,
          };
        });
      const folded = await state();
      expect({ head: folded.head, status: folded.status }).toEqual({ head: 0, status: 0 });
      await search.focus();
      await settled(page);
      expect(await state()).toEqual({ head: 0, status: 0, field: [390 - 2 * textEdge.phone, textEdge.phone, 8], onTop: true });
      await page.keyboard.press("Escape");
      await settled(page);
      expect({ ...(await state()), field: [], onTop: false }).toEqual({ head: 0, status: 0, field: [], onTop: false });
    },
    { width: 390, host: true, path: true, bare: true },
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
