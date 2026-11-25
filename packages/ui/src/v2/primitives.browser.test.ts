import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { personColor } from "../surfaces/person-color";
import { measureV2Layout } from "./testing";
import { gripTolerance, hairline, heights, textEdge, typeRoles } from "./tokens";

// Every v2 primitive measured in a real engine, in the place where the approved mockup puts it: the layout rules of
// measureV2Layout (edges, double lines, type roles, grips at DPR 1 and 2), and the numbers of the mockup (heights by
// place, text edges, marks on one pixel, cut text that never widens its column, no line inside a group).
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-primitives-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { fixtures } = await import("../../test/v2-fixtures");
const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const markup = Object.fromEntries(
  Object.entries(fixtures).map(([name, fixture]) => [name, renderToString(() => createComponent(fixture, {}))]),
) as Record<keyof typeof fixtures, string>;

// Icons take one em without their font, so the layout does not depend on a font file in the test.
const testCss =
  "html, body { margin: 0; height: 100%; } .frame { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (name: keyof typeof fixtures, { width = 1440, scale = 1 } = {}): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: scale });
  await page.setContent(
    `<!doctype html><html lang="de"><head><style>${css}</style><style>${testCss}</style></head>` +
      `<body class="k2-ui"><div class="frame">${markup[name]}</div></body></html>`,
  );
  await settled(page);
  return page;
};

const TEST_TIMEOUT = 30_000;

/**
 * Narrows the frame in a wide window until the element `selector` is `width` px wide, so a primitive meets a narrow
 * column, not a narrow window. The sidebar gives way down to its minimum on the way, so it measures again until the
 * width is reached.
 */
const narrowColumn = async (page: Page, selector: string, width: number) => {
  await page.evaluate(
    ([target, wanted]) => {
      const frame = document.querySelector<HTMLElement>(".frame")!;
      const element = document.querySelector(target)!;
      // the frame's width before it loses its right edge: a workspace takes the width of its place and brings none
      const start = frame.getBoundingClientRect().width;
      frame.style.right = "auto";
      frame.style.boxSizing = "border-box";
      frame.style.width = `${start}px`;
      for (let step = 0; step < 6; step++) {
        const short = element.getBoundingClientRect().width - wanted;
        if (Math.abs(short) < 0.5) break;
        frame.style.width = `${frame.getBoundingClientRect().width - short}px`;
      }
    },
    [selector, width] as const,
  );
  await settled(page);
};

describe("v2 primitives keep the layout rules", () => {
  for (const name of Object.keys(fixtures) as (keyof typeof fixtures)[])
    for (const width of [1440, 390])
      for (const scale of [1, 2])
        test(
          `${name} at ${width} px, DPR ${scale}`,
          async () => {
            const page = await open(name, { width, scale });
            try {
              const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
              expect(layout.problems).toEqual([]);
              expect(layout.measured.lines).toBeGreaterThan(0);
              expect(layout.measured.texts).toBeGreaterThan(10);
              if (width === 1440) expect(layout.grips.length).toBeGreaterThan(0);
              for (const grip of layout.grips) {
                expect(Math.abs(grip.dom)).toBeLessThanOrEqual(gripTolerance);
                if (grip.pixels !== null) expect(Math.abs(grip.pixels)).toBeLessThanOrEqual(gripTolerance);
              }
            } finally {
              await page.close();
            }
          },
          TEST_TIMEOUT,
        );
});

describe("v2 primitives keep the numbers of the mockup", () => {
  test("every primitive marks its root with data-k2-part", async () => {
    const page = await open("layout");
    const parts = new Set<string>();
    try {
      for (const name of Object.keys(fixtures) as (keyof typeof fixtures)[]) {
        await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body class="k2-ui">${markup[name]}</body></html>`);
        for (const part of await page.$$eval("[data-k2-part]", (elements) =>
          elements.map((element) => element.getAttribute("data-k2-part")!),
        ))
          parts.add(part);
      }
    } finally {
      await page.close();
    }
    for (const part of [
      "Workspace",
      "Pane",
      "Pane.Split",
      "Bar",
      "Band",
      "Cells",
      "Cells.Cell",
      "Tiles",
      "Section",
      "Group",
      "List",
      "Row",
      "Table",
      "Facts",
      "Text",
      "Prose",
      "Icon",
      "Avatar",
      "Chip",
      "Progress",
      "Inline",
      "Button",
      "Field",
      "Field.Row",
      "Input",
      "Select",
      "DateInput",
      "Check",
      "Choice",
      "Canvas",
      "Nav",
      "Tabs",
      "StatusRow",
      "Notice",
      "Digest",
      "RecordHead",
      "Steps",
      "Path",
    ])
      expect(parts).toContain(part);
  });

  for (const width of [1440, 390])
    test(
      `${width} px: bars and rows take their height from their place, text starts on the edge`,
      async () => {
        // on the phone the list is the page while nothing is open
        const page = await open(width < textEdge.phoneBelow ? "list" : "layout", { width });
        try {
          const numbers = await page.evaluate(() => {
            const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
            const textLeft = (selector: string) => {
              const element = document.querySelector(selector)!;
              const range = document.createRange();
              range.selectNodeContents(element);
              return range.getBoundingClientRect().left;
            };
            const rows = [...document.querySelectorAll<HTMLElement>(".k2-list > .k2-row")];
            const list = rows[0]!.getBoundingClientRect();
            return {
              head: box('.k2-ws-main > [data-slot="head"] > .k2-bar').height,
              status: box('[data-k2-part="StatusRow"]').height,
              // the plain bar of the reader (there only while something is open)
              bar: document.querySelector(".k2-pane[data-detail]")
                ? box('.k2-pane[data-detail] > [data-slot="status"] > .k2-bar').height
                : 0,
              rows: rows.map((row) => row.getBoundingClientRect().height),
              // the long title of the row of three lines stays on its line and ends in "…"
              title: (() => {
                const title = rows[2]!.querySelector<HTMLElement>(".k2-row-title")!;
                return [getComputedStyle(title).textOverflow, title.scrollWidth > title.clientWidth];
              })(),
              iconText: textLeft(".k2-list > .k2-row .k2-row-title") - list.left,
              // flow text in a band of the reader on a wide screen; the lead of the status row on the phone
              bandText:
                window.innerWidth >= 768
                  ? textLeft(".k2-band[data-tone] > .k2-text") - document.querySelector(".k2-band[data-tone]")!.getBoundingClientRect().left
                  : document.querySelector('[data-k2-part="StatusRow"] .k2-mark')!.getBoundingClientRect().left -
                    document.querySelector('[data-k2-part="StatusRow"]')!.getBoundingClientRect().left,
            };
          });
          const edge = width < textEdge.phoneBelow ? textEdge.phone : textEdge.wide;
          expect(numbers.head).toBe(width < textEdge.phoneBelow ? heights.tabs : heights.head);
          expect(numbers.status).toBe(heights.status);
          // The rows as the mockup measures them: one line 40; two lines 53 and three lines 73 (their content of 36 and
          // 56 px, 8 px above and below, and the line); with a button at the end 60 and no line, as the last part of its
          // column. On the phone one line takes 60.
          if (width >= textEdge.phoneBelow) {
            expect(numbers.bar).toBe(heights.bar);
            expect(numbers.rows).toEqual([heights.row, heights.row2 + hairline.width, heights.row3 + hairline.width, 60]);
          } else expect(numbers.rows.slice(0, 3)).toEqual([60, heights.row2 + hairline.width, heights.row3 + hairline.width]);
          expect(numbers.title).toEqual(["ellipsis", true]);
          expect(numbers.iconText).toBe(edge + textEdge.afterIcon);
          expect(numbers.bandText).toBe(edge);
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT,
    );

  for (const width of [1440, 390])
    test(
      `${width} px: an open detail stands beside its list on a wide screen; on the phone it is the page, with the way back`,
      async () => {
        const page = await open("layout", { width });
        try {
          const shown = await page.evaluate(() => {
            const seen = (selector: string) => {
              const element = document.querySelector(selector);
              return !!element && element.getBoundingClientRect().width > 0;
            };
            const detail = document.querySelector(".k2-pane[data-detail]")!.getBoundingClientRect();
            const workspace = document.querySelector("[data-k2-workspace]")!.getBoundingClientRect();
            // the way back is the public part `Back`, so a shell can find it
            const back = document.querySelector('.k2-pane[data-detail] > [data-k2-part="Back"]');
            return {
              list: seen('.k2-pane[aria-label="Breite der Liste"]'),
              head: seen('.k2-ws-main > [data-slot="head"] > .k2-bar'),
              detail: Math.round(detail.width - workspace.width),
              back: back ? Math.round(back.getBoundingClientRect().height) : -1,
              top: back ? Math.round(back.getBoundingClientRect().top - workspace.top) : -1,
            };
          });
          if (width >= textEdge.phoneBelow) expect(shown).toMatchObject({ list: true, head: true, back: 0 });
          else {
            // the detail takes the whole workspace: the head of the workspace gives way, and its way back is the one bar
            // of 44 px above its head, at the top
            expect(shown).toEqual({ list: false, head: false, detail: 0, back: heights.tabs, top: 0 });
            expect(await page.getByRole("link", { name: "Posteingang" }).getAttribute("href")).toBe("#posteingang");
          }
          expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT,
    );

  // The line of state of an open entry ("3 Nachrichten · Wartet auf Antwort · Tag") is the detail's `status`: a bar of
  // 40 px right under the head that stays there while the message scrolls (mockup mail.html: 117-157).
  for (const width of [1440, 390])
    test(
      `${width} px: a Bar as a pane's status is 40 px under the head and stays while the pane scrolls`,
      async () => {
        const page = await open("layout", { width });
        try {
          // a short window, so the message is longer than its column and scrolls
          await page.setViewportSize({ width, height: 420 });
          await settled(page);
          const place = () =>
            page.evaluate(() => {
              const pane = document.querySelector(".k2-pane[data-detail]")!;
              const head = pane.querySelector(':scope > [data-slot="head"] > .k2-bar')!.getBoundingClientRect();
              const bar = pane.querySelector(':scope > [data-slot="status"] > .k2-bar')!.getBoundingClientRect();
              return { height: Math.round(bar.height), gap: Math.round(bar.top - head.bottom), top: Math.round(bar.top) };
            });
          const before = await place();
          // one line is 40 px; on the phone this line of things takes a second line instead of being cut
          expect(before.gap).toBe(0);
          if (width >= textEdge.phoneBelow) expect(before.height).toBe(heights.bar);
          else expect(before.height).toBeGreaterThan(heights.bar);
          // its controls are the small ones of a 40 px bar, not those of a head
          const link = await page.getByRole("button", { name: "Verknüpfen" }).boundingBox();
          expect(Math.round(link?.height ?? 0)).toBe(heights.controlSmall);
          await page.locator(".k2-pane[data-detail] > .k2-scroll").evaluate((scroll) => scroll.scrollTo({ top: 200 }));
          await settled(page);
          expect(await page.locator(".k2-pane[data-detail] > .k2-scroll").evaluate((scroll) => scroll.scrollTop)).toBeGreaterThan(0);
          expect(await place()).toEqual(before);
          // a status row above a list keeps its 52 px
          expect(Math.round((await page.locator('[data-k2-part="StatusRow"]').first().boundingBox())?.height ?? 0)).toBe(
            width < textEdge.phoneBelow ? 0 : heights.status,
          );
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT,
    );

  // On the phone the title of an open entry is the page's title: beside the actions the head keeps ("…") it is never
  // cut, it takes a second line and the head grows; on a wide screen it stays one line in a head of 52 px.
  for (const width of [390, 1440])
    test(
      `${width} px: the title of an open entry ${width < 768 ? "wraps beside the kept actions instead of being cut" : "stays one line"}`,
      async () => {
        const page = await open("layout", { width });
        try {
          const head = await page.evaluate(() => {
            const bar = document.querySelector('.k2-pane[data-detail] > [data-slot="head"] > .k2-bar')!;
            const title = bar.querySelector<HTMLElement>(".k2-bar-start > .k2-text")!;
            // a subject longer than one line of a phone in every engine's font
            title.textContent = "Angebot Eichenplatten – Liefertermin KW 49";
            const more = bar.querySelector('[aria-label="Weitere Aktionen"]')!.getBoundingClientRect();
            const box = title.getBoundingClientRect();
            return {
              cut: title.scrollHeight > title.clientHeight + 1 || title.scrollWidth > title.clientWidth + 1,
              lines: Math.round(box.height / Number.parseFloat(getComputedStyle(title).lineHeight)),
              beside: box.right <= more.left + 0.5 && more.width > 0,
              height: Math.round(bar.getBoundingClientRect().height),
            };
          });
          if (width < textEdge.phoneBelow)
            expect(head).toEqual({
              cut: false,
              lines: 2,
              beside: true,
              // two lines of the lead role, 8 px of air above and below (the bar's padding), the line below
              height: 2 * typeRoles.lead.lineHeight + 2 * 8 + hairline.width,
            });
          else expect(head).toMatchObject({ lines: 1, beside: true, height: heights.status });
          expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT,
    );

  // On the phone an open detail has one way back: its Back. The × that closes it beside the list (without `keep`, as
  // every head action) gives way in its head from 767 px down; from 768 px the × closes the detail and there is no Back.
  for (const width of [390, 767, 768, 1440])
    test(
      `${width} px: an open detail shows either its way back or its close ×, never both`,
      async () => {
        const page = await open("layout", { width });
        try {
          const shown = await page.evaluate(() => {
            const seen = (element: Element | null) => !!element && element.getBoundingClientRect().width > 0;
            const pane = document.querySelector(".k2-pane[data-detail]")!;
            return {
              back: seen(pane.querySelector(':scope > [data-k2-part="Back"]')),
              close: seen(pane.querySelector('[data-slot="head"] [aria-label="Schließen"]')),
              // the other kept or unkept actions of the head follow their own rule: "Erledigt" leaves on the phone
              done: seen(
                [...pane.querySelectorAll('[data-slot="head"] .k2-btn')].find((button) => button.textContent === "Erledigt") ?? null,
              ),
            };
          });
          const phone = width < textEdge.phoneBelow;
          expect(shown).toEqual({ back: phone, close: !phone, done: !phone });
          // (the layout rules at the two boundary widths belong to the workspace between phone and wide screen, which
          // still cuts the detail's head at 768; measured here at the phone and the wide screen)
          if (width === 390 || width === 1440) expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT,
    );

  // A long name of the list (a search) is cut with "…" on one line: the way back never leaves its bar, and the whole
  // name stays its accessible name and its hint under the pointer.
  test(
    "390 px: the way back to a list with a long name stays on one line in its bar, ending in …",
    async () => {
      const name = "Suchergebnisse für „Eichenplatten Lieferung KW 49“ in allen Postfächern und Ordnern";
      const page = await open("longBack", { width: 390 });
      try {
        const found = await page.evaluate(() => {
          const bar = document.querySelector('.k2-pane[data-detail] > [data-k2-part="Back"]')!;
          const button = bar.querySelector(".k2-btn")!;
          const label = button.querySelector<HTMLElement>(".k2-btn-label")!;
          const box = bar.getBoundingClientRect();
          const right = box.right - Number.parseFloat(getComputedStyle(bar).paddingRight);
          return {
            inside: button.getBoundingClientRect().right <= right + 0.5,
            lines: Math.round(label.getBoundingClientRect().height / 20),
            ellipsis: getComputedStyle(label).textOverflow === "ellipsis" && label.scrollWidth > label.clientWidth,
            title: button.getAttribute("title"),
          };
        });
        expect(found).toEqual({ inside: true, lines: 1, ellipsis: true, title: name });
        expect(await page.getByRole("link", { name, exact: true }).count()).toBe(1);
        const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
        expect(layout.cut).toEqual([]);
        expect(layout.problems).toEqual([]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  for (const scale of [1, 2])
    test(
      `DPR ${scale}: check, radio and switch sit on the same pixel empty, set and mixed, centred on the first text line`,
      async () => {
        const page = await open("controls", { scale });
        try {
          const marks = await page.$$eval("[data-k2-mark]", (elements) =>
            elements.map((mark) => {
              const box = mark.getBoundingClientRect();
              // the first line box of the label: its top plus half the line height (glyph boxes depend on the font)
              const text = mark.closest(".k2-choice")!.querySelector(".k2-choice-text")!;
              const lineCentre = text.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(text).lineHeight) / 2;
              return { kind: mark.className, top: box.top, height: box.height, centre: box.top + box.height / 2, lineCentre };
            }),
          );
          expect(marks.length).toBe(7);
          for (const mark of marks) expect(Math.abs(mark.centre - mark.lineCentre)).toBeLessThanOrEqual(gripTolerance);
          const checks = marks.filter((mark) => mark.kind === "k2-check");
          expect(checks.length).toBe(3);
          // each mark relative to its own row: same offset, same size, whatever its state
          expect(new Set(checks.map((mark) => `${mark.height}:${mark.centre - mark.lineCentre}`)).size).toBe(1);
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT,
    );

  test(
    "a table column is exactly its default wide; cut text never widens it, rows without wrap are 40 px",
    async () => {
      const page = await open("table");
      try {
        const table = await page.evaluate(() => {
          const heads = [...document.querySelectorAll(".k2-table th")].map((head) => head.getBoundingClientRect().width);
          const cells = [...document.querySelectorAll(".k2-table tbody tr")].map((row) => row.getBoundingClientRect().height);
          const cut = document.querySelector<HTMLElement>(".k2-table tbody td .k2-cell-line:not([data-wrap])")!;
          const wrap = document.querySelector<HTMLElement>(".k2-table tbody td .k2-cell-line[data-wrap]")!;
          // #4076: a chip is taller than the cut line it stands in, and still shows whole: the line cuts sideways only
          const chip = document.querySelector(".k2-table tbody td .k2-cell-line .k2-chip")!.getBoundingClientRect();
          const line = document.querySelector(".k2-table tbody td .k2-cell-line:has(.k2-chip)")!;
          const shown = line.getBoundingClientRect();
          const clipsBelow = getComputedStyle(line).overflowY !== "visible";
          return {
            heads,
            cells,
            cut: cut.scrollWidth > cut.clientWidth,
            wrapLines: Math.round(wrap.getBoundingClientRect().height / 20),
            chip: [chip.height > shown.height, clipsBelow ? chip.top >= shown.top && chip.bottom <= shown.bottom : true],
          };
        });
        expect(table.chip).toEqual([true, true]);
        expect(table.heads.slice(0, -1)).toEqual([260, 180, 300, 140]);
        expect(table.heads.at(-1)!).toBeGreaterThanOrEqual(120);
        expect(table.cut).toBe(true);
        expect(table.wrapLines).toBe(3);
        expect(table.cells[1]).toBe(heights.row);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "line 2 of a row reaches its end, a person has the colour of their name, a notice's sign stands beside its title",
    async () => {
      const page = await open("layout");
      try {
        const found = await page.evaluate(() => {
          const row = [...document.querySelectorAll(".k2-row[data-lines='3']")].find((each) => each.querySelector(".k2-row-marks"))!;
          const right = (selector: string) => row.querySelector(selector)!.getBoundingClientRect().right;
          const avatar = document.querySelector('.k2-av[aria-label="Ada Renz"]')!;
          const centre = (element: Element) => {
            const box = element.getBoundingClientRect();
            return box.top + box.height / 2;
          };
          return {
            line2: right(".k2-row-l2") - right(".k2-row-time"),
            avatar: getComputedStyle(avatar).backgroundColor,
            notices: [...document.querySelectorAll(".k2-notice[data-title]")].map(
              (notice) => centre(notice.querySelector(":scope > .k2-icon")!) - centre(notice.querySelector(".k2-notice-title")!),
            ),
          };
        });
        // line 2 is as wide as the row's text area: its right edge is the right edge of the time above it
        expect(found.line2).toBe(0);
        const hex = personColor("Ada Renz");
        const rgb = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
        expect(found.avatar).toBe(`rgb(${rgb.join(", ")})`);
        // with and without deeds at the end, the sign stands on the title's line
        expect(found.notices.length).toBe(2);
        for (const offset of found.notices) expect(Math.abs(offset)).toBeLessThanOrEqual(1);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "a column of 400 px in a wide window takes the narrow form: a table becomes rows, fields and steps stand one under the other",
    async () => {
      const narrow = (page: Page, pane: string) => narrowColumn(page, pane, 400);
      const messages = await open("messages");
      const structure = await open("structure");
      try {
        // wide: the table is a table with its column grip, the fields of a row stand side by side
        const wide = await messages.evaluate(() => ({
          table: getComputedStyle(document.querySelector(".k2-table-scroll")!).display,
          row: new Set([...document.querySelectorAll(".k2-frow > .k2-field")].map((field) => field.getBoundingClientRect().top)).size,
        }));
        expect(wide).toEqual({ table: "block", row: 1 });
        await narrow(messages, '.k2-pane[aria-label="Auswahl"]');
        const narrowed = await messages.evaluate(() => ({
          pane: Math.round(document.querySelector('.k2-pane[aria-label="Auswahl"]')!.getBoundingClientRect().width),
          table: getComputedStyle(document.querySelector(".k2-table-scroll")!).display,
          phone: document.querySelectorAll(".k2-table-phone .k2-row").length,
          grips: [...document.querySelectorAll(".k2-cgrip")].filter((grip) => grip.getBoundingClientRect().width > 0).length,
          row: new Set([...document.querySelectorAll(".k2-frow > .k2-field")].map((field) => field.getBoundingClientRect().top)).size,
          rowHeight: Math.round(document.querySelector(".k2-band .k2-row")!.getBoundingClientRect().height),
        }));
        // the row of a message keeps its desktop height: touch sizes follow the window, not the column
        expect(narrowed).toEqual({ pane: 400, table: "none", phone: 2, grips: 0, row: 2, rowHeight: narrowed.rowHeight });
        expect(narrowed.rowHeight).toBeLessThan(60);
        expect((await measureV2Layout(messages, { root: "[data-k2-workspace]" })).problems).toEqual([]);
        await narrow(structure, ".k2-pane:has(.k2-steps)");
        const steps = await structure.evaluate(() => {
          const items = [...document.querySelectorAll(".k2-step")].map((step) => step.getBoundingClientRect());
          return {
            lefts: new Set(items.map((box) => Math.round(box.left))).size,
            tops: new Set(items.map((box) => Math.round(box.top))).size,
          };
        });
        expect(steps).toEqual({ lefts: 1, tops: 3 });
      } finally {
        await messages.close();
        await structure.close();
      }
    },
    TEST_TIMEOUT,
  );

  // A bar with a line of things (the state of a conversation, in the pane's status): below 480 px of its column it
  // wraps instead of cutting, one line stays 40 px on both sides of 480, and only a second line makes it higher.
  // 480 and 479: a column of the wide window; 300: a phone, where the open detail is the whole page
  for (const column of [480, 479, 300])
    test(
      `a bar with a line of things in a column of ${column} px: nothing is cut, one line is 40 px`,
      async () => {
        const page = await open("layout", { width: column < 400 ? column : 1440 });
        try {
          if (column >= 400) await narrowColumn(page, ".k2-pane[data-detail]", column);
          const found = await page.evaluate(() => {
            const bar = document.querySelector('.k2-pane[data-detail] > [data-slot="status"] > .k2-bar')!;
            const box = bar.getBoundingClientRect();
            const style = getComputedStyle(bar);
            const inner = {
              left: box.left + Number.parseFloat(style.paddingLeft),
              right: box.right - Number.parseFloat(style.paddingRight),
              top: box.top + Number.parseFloat(style.paddingTop),
              bottom: box.bottom - Number.parseFloat(style.paddingBottom),
            };
            const things = [...bar.querySelectorAll(".k2-inline > *, .k2-bar-end > *")];
            const cut = things
              .filter((thing) => {
                const r = thing.getBoundingClientRect();
                // inside the bar's padding and shown by every box around it that clips
                for (let up = thing.parentElement; up && up !== bar; up = up.parentElement) {
                  const s = getComputedStyle(up);
                  if (s.display === "contents" || s.overflow === "visible") continue;
                  const c = up.getBoundingClientRect();
                  if (r.left < c.left - 0.5 || r.right > c.right + 0.5 || r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5) return true;
                }
                return r.left < inner.left - 0.5 || r.right > inner.right + 0.5 || r.top < inner.top - 0.5 || r.bottom > inner.bottom + 0.5;
              })
              .map((thing) => thing.textContent?.trim() || thing.getAttribute("aria-label"));
            const middles = things
              .map((thing) => {
                const r = thing.getBoundingClientRect();
                return (r.top + r.bottom) / 2;
              })
              .sort((a, b) => a - b);
            return {
              cut,
              lines: middles.filter((middle, index) => index === 0 || middle - middles[index - 1]! > 8).length,
              height: box.height,
              width: Math.round(box.width),
            };
          });
          // the test frame keeps 8 px around the workspace in a phone window
          expect(found.width).toBe(column >= 400 ? column : column - 16);
          expect(found.cut).toEqual([]);
          if (column >= 400) expect([found.lines, found.height]).toEqual([1, heights.bar]);
          else {
            expect(found.lines).toBe(2);
            expect(found.height).toBeGreaterThan(heights.bar);
          }
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT,
    );

  // A row's note shares the first line with the title in equal parts and takes no more than it needs: a count and a
  // number stay whole in a narrow column, while a long title is cut (three lines) or breaks (one or two lines).
  for (const column of [400, 340])
    test(
      `a row's count and number stay whole in a column of ${column} px`,
      async () => {
        const page = await open("list");
        try {
          await narrowColumn(page, '.k2-pane[aria-label="Breite der Liste"]', column);
          const notes = await page.evaluate(() =>
            [...document.querySelectorAll(".k2-list > .k2-row .k2-row-meta")].map((meta) => [
              meta.textContent,
              meta.scrollWidth <= meta.clientWidth && meta.clientWidth > 0,
            ]),
          );
          expect(notes).toEqual([
            ["RE-2611-0042", true],
            ["3", true],
          ]);
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT,
    );

  for (const column of [360, 480, 640])
    test(
      `the bar of a selection in a column of ${column} px: nothing is cut, words give way to symbols first`,
      async () => {
        const page = await open("messages");
        try {
          // the window stays wide; only the column narrows (the frame is cut until the bar is `column` wide), so the
          // bar measures its column, not the window
          await narrowColumn(page, '[data-k2-part="StatusRow"]', column);
          const bar = await page.evaluate(() => {
            const row = document.querySelector('[data-k2-part="StatusRow"]')!;
            const edge = Number.parseFloat(getComputedStyle(row).paddingRight);
            const right = row.getBoundingClientRect().right - edge;
            return {
              width: Math.round(row.getBoundingClientRect().width),
              buttons: [...row.querySelectorAll(".k2-btn")].map((button) => ({
                name: button.textContent?.trim(),
                inside: button.getBoundingClientRect().right <= right + 0.5,
                whole: button.scrollWidth <= button.clientWidth,
                words: button.querySelector(".k2-btn-label")!.getBoundingClientRect().width > 1,
                title: button.getAttribute("title"),
              })),
            };
          });
          expect(bar.width).toBe(column);
          for (const button of bar.buttons) expect([button.name, button.inside, button.whole]).toEqual([button.name, true, true]);
          // 640: all words; 480: the actions are symbols, the way out keeps its words; 360: the way out is its × too
          expect(bar.buttons.map((button) => button.words)).toEqual(
            column >= 600 ? [true, true, true, true] : column >= 400 ? [false, false, false, true] : [false, false, false, false],
          );
          // every button keeps its name, and a hint under the pointer for when only its symbol shows
          expect(await page.getByRole("button", { name: "Archivieren" }).count()).toBe(1);
          expect(await page.getByRole("button", { name: "Auswahl aufheben" }).count()).toBe(1);
          for (const button of bar.buttons) expect(button.title).toBe(button.name);
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT,
    );

  // #4073: on the phone the bar of a selection keeps count, action and way out within its text edge
  test(
    "390 px: the bar of a selection in the large table keeps its text edge and cuts no label",
    async () => {
      const page = await open("grid", { width: 390 });
      try {
        const buttons = await page.evaluate(() => {
          const row = document.querySelector('[data-k2-part="StatusRow"]')!;
          const right = row.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(row).paddingRight);
          return [...row.querySelectorAll(".k2-btn")].map((button) => [
            button.textContent?.trim(),
            button.getBoundingClientRect().right <= right + 0.5,
            button.scrollWidth <= button.clientWidth,
          ]);
        });
        expect(buttons).toEqual([
          ["Exportieren", true, true],
          ["Auswahl aufheben", true, true],
        ]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  for (const width of [1440, 390])
    test(
      `at ${width}: a reply box stands on the text edge, a required field says so, a choice shows its question, a phone row of a table needs no lead, no column grip on the phone`,
      async () => {
        const page = await open("messages", { width });
        try {
          const edge = width < textEdge.phoneBelow ? textEdge.phone : textEdge.wide;
          const found = await page.evaluate(() => {
            const pane = document.querySelector('.k2-pane[aria-label="Auswahl"]')!.getBoundingClientRect();
            const left = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().left - pane.left;
            const phoneRow = document.querySelector(".k2-table-phone .k2-row");
            return {
              reply: left(".k2-band > .k2-input[data-multiline]"),
              phoneText: phoneRow && getComputedStyle(phoneRow).display !== "none" ? left(".k2-table-phone .k2-row-title") : null,
              grips: [...document.querySelectorAll(".k2-cgrip")].filter((grip) => grip.getBoundingClientRect().width > 0).length,
            };
          });
          expect(found.reply).toBe(edge);
          if (width < textEdge.phoneBelow) {
            expect(found.phoneText).toBe(edge);
            expect(found.grips).toBe(0);
          } else expect(found.grips).toBe(1);
          expect(await page.getByRole("textbox", { name: "Betreff" }).getAttribute("required")).not.toBeNull();
          expect(await page.getByRole("group", { name: "Antwort per" }).getByRole("radio").count()).toBe(2);
          expect(await page.getByText("Antwort per", { exact: true }).isVisible()).toBe(true);
          expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT,
    );

  test(
    "two messages in a row: one line between their bands, none inside a band, the tiles framed on their own",
    async () => {
      const page = await open("messages");
      try {
        const lines = await page.evaluate(() => {
          const bands = [...document.querySelectorAll(".k2-band")];
          // a structural line: a box with a top or bottom border that is not round (tiles and buttons are round)
          const inside = bands.flatMap((band) =>
            [...band.querySelectorAll("*")]
              .filter((element) => {
                const style = getComputedStyle(element);
                const line = Number.parseFloat(style.borderTopWidth) > 0 || Number.parseFloat(style.borderBottomWidth) > 0;
                return line && Number.parseFloat(style.borderTopLeftRadius) === 0;
              })
              .map((element) => element.className),
          );
          const [first, second] = bands.map((band) => band.getBoundingClientRect());
          const own = bands.map((band) => [
            Number.parseFloat(getComputedStyle(band).borderTopWidth),
            Number.parseFloat(getComputedStyle(band).borderBottomWidth),
          ]);
          return { inside, touching: second!.top - first!.bottom, own, tiles: second ? bands[1]!.querySelectorAll(".k2-tile").length : 0 };
        });
        expect(lines.inside).toEqual([]);
        // the bands touch; each owns its bottom line only, so between them there is exactly one
        expect(lines.touching).toBe(0);
        for (const own of lines.own) expect(own).toEqual([0, 1]);
        expect(lines.tiles).toBe(1);
        expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  for (const width of [1440, 390])
    test(
      `steps at ${width}: a 1 px line joins the circles (across on the desktop, down on the phone, mockup v17), none after the last`,
      async () => {
        const page = await open("structure", { width });
        try {
          const steps = await page.$$eval(".k2-step", (items) =>
            items.map((step) => {
              const line = getComputedStyle(step, "::before");
              const box = step.getBoundingClientRect();
              const px = (value: string) => Math.round(Number.parseFloat(value));
              const next = step.nextElementSibling?.getBoundingClientRect();
              return {
                shown: line.display !== "none",
                line: [px(line.left), px(line.top), px(line.width), px(line.height)],
                step: [Math.round(box.width), Math.round(box.height)] as const,
                // the space to the next step: 12 px on the phone (mockup v17)
                gap: next ? Math.round(next.top - box.bottom) : null,
                colour: line.backgroundColor,
              };
            }),
          );
          expect(steps.at(-1)!.shown).toBe(false);
          for (const { shown, line, step, gap, colour } of steps.slice(0, -1)) {
            expect(shown).toBe(true);
            // desktop: from the circle (20 px) to the end of the step, 9 px down; phone: 9 px in, from below the circle
            // (20 px) across the 12 px between the steps, in n400
            if (width >= textEdge.phoneBelow) expect(line).toEqual([20, 9, step[0] - 20, 1]);
            else {
              expect(gap).toBe(12);
              expect(line).toEqual([9, 20, 1, step[1] - 20 + 12]);
              expect(colour).toBe("rgb(161, 161, 170)");
            }
          }
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT,
    );

  test(
    "K5: the controls of a field row stand on one line, with a hint, an error or a note in the label line",
    async () => {
      const page = await open("controls");
      try {
        const rows = await page.$$eval(".k2-frow", (frows) =>
          frows.map((row) => [...row.querySelectorAll(".k2-input")].map((control) => control.getBoundingClientRect().top)),
        );
        expect(rows.length).toBeGreaterThan(1);
        for (const tops of rows) expect(new Set(tops).size).toBe(1);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "rule 9: a canvas inside a band draws no line; the band owns its one line below, so two bands in a row show one",
    async () => {
      const page = await open("layout");
      try {
        const found = await page.evaluate(() => {
          const band = document.querySelector(".k2-band:has(> .k2-canvas)")!;
          const lines = (element: Element) => {
            const style = getComputedStyle(element);
            return [Number.parseFloat(style.borderTopWidth), Number.parseFloat(style.borderBottomWidth)];
          };
          const next = band.nextElementSibling!;
          return {
            canvas: lines(band.querySelector(":scope > .k2-canvas")!),
            band: lines(band),
            next: [next.className, lines(next)[0]],
            gap: next.getBoundingClientRect().top - band.getBoundingClientRect().bottom,
          };
        });
        expect(found.canvas).toEqual([0, 0]);
        expect(found.band).toEqual([0, 1]);
        // the band after it draws no line on top and touches it: one line between them
        expect(found.next).toEqual(["k2-band", 0]);
        expect(found.gap).toBe(0);
        expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).double).toEqual([]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "rule 9: no line under a section head or between its entries, none inside a group; one line at the end of a section",
    async () => {
      const page = await open("structure");
      try {
        const lines = await page.evaluate(() => {
          // a structural line: a square box with a top or bottom border (controls and marks are round and float on their own)
          const drawn = (element: Element) => {
            const style = getComputedStyle(element);
            return (
              Number.parseFloat(style.borderTopLeftRadius) === 0 &&
              ["top", "bottom"].some((side) => Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0)
            );
          };
          const inside = (selector: string) => [...document.querySelectorAll(selector)].filter(drawn).map((element) => element.className);
          return {
            sectionRows: inside(".k2-sec > .k2-row, .k2-sec .k2-sh"),
            groupInside: inside(".k2-group *"),
            sectionEnd: getComputedStyle(document.querySelector(".k2-pane:not([data-side]) .k2-sec")!).borderBottomWidth,
          };
        });
        expect(lines.sectionRows).toEqual([]);
        expect(lines.groupInside).toEqual([]);
        expect(lines.sectionEnd).toBe("1px");
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );
});

describe("v2 panes that stand one under the other", () => {
  // Below 768 px the side column stands under the table; up to 480 px of its pane the large table still shows (its
  // phone rows only below), so its own last line meets the seam unless it gives way.
  test(
    "a large table above a stacked side column at 600 px: one line at the seam",
    async () => {
      const page = await open("accessGrid", { width: 600 });
      try {
        const shown = await page.evaluate(() => getComputedStyle(document.querySelector(".k2-table[data-grid]")!).display);
        expect(shown).toBe("table");
        const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
        expect(layout.problems).toEqual([]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );
});

describe("v2 heads that sort lead to an address", () => {
  test(
    "without a deed in place, a head that sorts is a link to the page sorted so; the server markup says the order",
    async () => {
      const page = await open("access");
      try {
        const heads = await page.evaluate(() =>
          [...document.querySelectorAll(".k2-table th")].map((th) => [
            th.getAttribute("aria-sort"),
            th.querySelector("a.k2-th-sort")?.getAttribute("href") ?? null,
          ]),
        );
        // the sorted column leads to its other direction, another column to its first
        expect(heads).toEqual([
          ["ascending", "?sort=-0"],
          [null, "?sort=1"],
          [null, null],
        ]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );
});
