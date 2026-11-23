import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";
import { measureV2Layout } from "../../test/measure-v2-layout";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { personColor } from "../surfaces/person-color";
import { gripTolerance, hairline, heights, textEdge } from "./tokens";

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
      frame.style.right = "auto";
      frame.style.boxSizing = "border-box";
      frame.style.width = `${frame.getBoundingClientRect().width}px`;
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
              bar: document.querySelector(".k2-pane[data-detail]") ? box(".k2-pane[data-detail] .k2-scroll > .k2-bar").height : 0,
              rows: rows.map((row) => row.getBoundingClientRect().height),
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
          // 56 px, 8 px above and below, and the line); with a button at the end 61. On the phone one line takes 60.
          if (width >= textEdge.phoneBelow) {
            expect(numbers.bar).toBe(heights.bar);
            expect(numbers.rows).toEqual([heights.row, heights.row2 + hairline.width, heights.row3 + hairline.width, 61]);
          } else expect(numbers.rows.slice(0, 3)).toEqual([60, heights.row2 + hairline.width, heights.row3 + hairline.width]);
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
            const back = document.querySelector(".k2-pane-back");
            return {
              list: seen('.k2-pane[aria-label="Breite der Liste"]'),
              detail: Math.round(detail.width - workspace.width),
              back: back ? Math.round(back.getBoundingClientRect().height) : 0,
            };
          });
          if (width >= textEdge.phoneBelow) expect([shown.list, shown.back]).toEqual([true, 0]);
          else {
            // the detail takes the whole workspace; its way back is a bar of 44 px above its head
            expect(shown).toEqual({ list: false, detail: 0, back: heights.tabs });
            expect(await page.getByRole("link", { name: "Posteingang" }).getAttribute("href")).toBe("#posteingang");
          }
          expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
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
          return {
            heads,
            cells,
            cut: cut.scrollWidth > cut.clientWidth,
            wrapLines: Math.round(wrap.getBoundingClientRect().height / 20),
          };
        });
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
              })),
            };
          });
          expect(bar.width).toBe(column);
          for (const button of bar.buttons) expect([button.name, button.inside, button.whole]).toEqual([button.name, true, true]);
          // 640: all words; 480: the actions are symbols, the way out keeps its words; 360: the way out is its × too
          expect(bar.buttons.map((button) => button.words)).toEqual(
            column >= 600 ? [true, true, true, true] : column >= 400 ? [false, false, false, true] : [false, false, false, false],
          );
          // every button keeps its name
          expect(await page.getByRole("button", { name: "Archivieren" }).count()).toBe(1);
          expect(await page.getByRole("button", { name: "Auswahl aufheben" }).count()).toBe(1);
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
