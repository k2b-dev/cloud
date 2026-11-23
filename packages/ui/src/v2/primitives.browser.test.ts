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
        const page = await open("layout", { width });
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
              bar: box(".k2-pane[data-detail] .k2-scroll > .k2-bar").height,
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

  for (const width of [1440, 390])
    test(
      `steps at ${width}: a 1 px line joins the circles (across on the desktop, down on the phone, mockup v16), none after the last`,
      async () => {
        const page = await open("structure", { width });
        try {
          const steps = await page.$$eval(".k2-step", (items) =>
            items.map((step) => {
              const line = getComputedStyle(step, "::before");
              const box = step.getBoundingClientRect();
              const px = (value: string) => Math.round(Number.parseFloat(value));
              return {
                shown: line.display !== "none",
                line: [px(line.left), px(line.top), px(line.width), px(line.height)],
                step: [Math.round(box.width), Math.round(box.height)] as const,
              };
            }),
          );
          expect(steps.at(-1)!.shown).toBe(false);
          for (const { shown, line, step } of steps.slice(0, -1)) {
            expect(shown).toBe(true);
            // desktop: from the circle (20 px) to the end of the step, 9 px down; phone: 9 px in, from below the circle
            // (20 px) 8 px into the next step
            if (width >= textEdge.phoneBelow) expect(line).toEqual([20, 9, step[0] - 20, 1]);
            else expect(line).toEqual([9, 20, 1, step[1] - 20 + 8]);
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
