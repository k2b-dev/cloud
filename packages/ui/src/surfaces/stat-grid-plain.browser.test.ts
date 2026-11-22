import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

// Columns, the line between figures and where each row starts are layout, which only a real engine renders.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-stat-plain-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { StatCell } = await import("./StatCell");
const { StatGrid } = await import("./StatGrid");
const { LocaleProvider } = await import("../intl/locale");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");

/** The approved example: four figures under a page head, the third one overdue; or one figure per state. */
const markup = (options: { size?: "md" | "lg"; states?: boolean } = {}) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(StatGrid, {
          variant: "plain",
          size: options.size,
          get children() {
            if (options.states) {
              return [
                createComponent(StatCell, { label: "Lädt", value: 1, status: "loading" }),
                createComponent(StatCell, { label: "Fehler", value: 1, status: "error", onRetry: () => undefined }),
                createComponent(StatCell, { label: "Leer", value: null, sub: "Noch nichts gezählt" }),
                createComponent(StatCell, { label: "Ohne dritte Zeile", value: 7 }),
              ];
            }
            return [
              createComponent(StatCell, { label: "Offen", value: "__UNIT__", sub: "38 % des Bestands" }),
              createComponent(StatCell, {
                label: "Diese Woche fällig",
                value: 12,
                accent: { tone: "zinc", icon: "ti ti-trending-up", text: "4 mehr als Vorwoche" },
              }),
              createComponent(StatCell, {
                label: "Überfällig",
                value: 3,
                tone: "amber",
                accent: { tone: "amber", icon: "ti ti-alert-triangle", text: "älteste seit 2 Tagen" },
              }),
              createComponent(StatCell, { label: "Erledigt", value: 212, sub: "62 % von allen" }),
            ];
          },
        });
      },
    }),
  ).replace("__UNIT__", "128 <small>von 340</small>");

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const page = async (width: number, body: string) => {
  const tab = await browser.newPage({ viewport: { width, height: 900 } });
  await tab.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui" style="margin:0;padding:24px">${body}</body></html>`,
  );
  await settled(tab);
  return tab;
};

const measure = () => {
  const cells = Array.from(document.querySelectorAll<HTMLElement>(".k2b-stat-cell"));
  const top = (cell: HTMLElement, selector: string) => Math.round(cell.querySelector(selector)!.getBoundingClientRect().top);
  return {
    lefts: [...new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().left)))].length,
    widths: [...new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().width)))],
    rows: [...new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().top)))].length,
    lines: cells.map((cell) => getComputedStyle(cell).borderInlineStartWidth),
    surfaces: [
      ...new Set(
        cells.map(
          (cell) =>
            `${getComputedStyle(cell).backgroundColor}|${getComputedStyle(cell).boxShadow}|${getComputedStyle(cell).borderTopWidth}`,
        ),
      ),
    ],
    values: [...new Set(cells.map((cell) => top(cell, ".k2b-stat-cell__main") - Math.round(cell.getBoundingClientRect().top)))],
    supports: [...new Set(cells.map((cell) => top(cell, ".k2b-stat-cell__support") - Math.round(cell.getBoundingClientRect().top)))],
    supportHeights: [
      ...new Set(cells.map((cell) => Math.round(cell.querySelector(".k2b-stat-cell__support")!.getBoundingClientRect().height))),
    ],
    heights: [...new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().height)))],
    valueSize: getComputedStyle(cells[0]!.querySelector(".k2b-stat-cell__main")!.firstElementChild!).fontSize,
    unitSize: cells[0]!.querySelector("small") ? getComputedStyle(cells[0]!.querySelector("small")!).fontSize : null,
    colors: cells.map((cell) => [
      getComputedStyle(cell.querySelector(".k2b-stat-cell__main")!.firstElementChild!).color,
      getComputedStyle(cell.querySelector(".k2b-stat-cell__support")!).color,
    ]),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
};

describe("@k2b/ui key figures without tiles", () => {
  for (const [name, width, columns, lines] of [
    ["desktop", 1440, 4, ["0px", "1px", "1px", "1px"]],
    ["phone", 390, 2, ["0px", "1px", "0px", "1px"]],
  ] as const) {
    test(`on a ${name}: ${columns} equal columns, a thin line between, all figures on one line`, async () => {
      const tab = await page(width, markup());
      try {
        const row = await tab.evaluate(measure);
        expect(row.lefts).toBe(columns);
        expect(row.rows).toBe(4 / columns);
        expect(row.lines).toEqual([...lines]);
        // No frame, no surface, no shadow: only the line between figures.
        expect(row.surfaces).toEqual(["rgba(0, 0, 0, 0)|none|0px"]);
        // Every figure has the same three rows, so figures and third lines stand on one line.
        expect(row.values).toHaveLength(1);
        expect(row.supports).toHaveLength(1);
        expect(row.heights).toHaveLength(1);
        expect(row.valueSize).toBe("18px");
        expect(row.unitSize).toBe("14px");
        // The warning colours the figure and its third line; the others keep the text colours.
        const [open, , overdue] = row.colors;
        expect(overdue![0]).not.toBe(open![0]);
        expect(overdue![1]).not.toBe(open![1]);
        expect(overdue![0]).toBe(overdue![1]);
        expect(row.overflow).toBeLessThanOrEqual(0);
      } finally {
        await tab.close();
      }
    });
  }

  test("every state keeps the three rows, and an empty third line keeps its place", async () => {
    const tab = await page(1440, markup({ states: true }));
    try {
      const row = await tab.evaluate(measure);
      expect(row.values).toHaveLength(1);
      expect(row.supports).toHaveLength(1);
      expect(row.heights).toHaveLength(1);
      expect(row.supportHeights).toEqual([20]);
    } finally {
      await tab.close();
    }
  });

  // K11: a main figure is the lead statement at every size; lg adds no fifth text size.
  test("size lg keeps a main figure in the lead role", async () => {
    const tab = await page(1440, markup({ size: "lg" }));
    try {
      expect((await tab.evaluate(measure)).valueSize).toBe("18px");
    } finally {
      await tab.close();
    }
  });
});
