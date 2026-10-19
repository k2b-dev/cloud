import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "data-table-minimal.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { DataTable } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const params = new URLSearchParams(location.hash.slice(1));
const count = Number(params.get("columns") || 6);
const columns = Array.from({length: count}, (_, i) => ({id: 'c' + i, header: 'Field ' + i, value: i === 1 ? 'count' : 'name', align: i === 1 ? 'right' : 'left'}));
const rows = [{name: 'Alpha', count: 12}, {name: 'Beta', count: 34}, {name: 'Gamma', count: 56}];
render(() => {
  const [loading, setLoading] = createSignal(params.has("loading"));
  window.showRows = () => setLoading(false);
  return createComponent(DataTable, {
    columns, get rows() { return loading() ? [] : rows; }, get loading() { return loading(); },
    loadingRows: 3, hoverRows: true, surface: 'plain', density: params.has('compact') ? 'compact' : 'normal',
  });
}, document.getElementById('app'));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle minimal table fixture");
const script = await build.outputs[0]!.text();
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});
const load = async (theme: string, params = "") => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" data-theme="${theme}"><div id="app"></div><span id="muted-probe" style="color:var(--k2b-text-muted)"></span></body></html>`,
  );
  await page.evaluate((params) => {
    location.hash = params;
  }, params);
  await page.addScriptTag({ content: script });
  return page;
};
const geometry = (page: Page) =>
  page.evaluate(() => {
    const rect = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return { table: rect(document.querySelector("table")!), rows: [...document.querySelectorAll("tbody tr")].map(rect) };
  });
const noBorder = (width: string, style: string) => width === "0px" || style === "none";
const transparent = (color: string) => ["transparent", "rgba(0, 0, 0, 0)"].includes(color);

for (const theme of ["light", "dark"])
  describe(`minimal table in ${theme}`, () => {
    test("six columns have quiet rows, compact muted headings, tabular numbers and a hover fill", async () => {
      const page = await load(theme);
      try {
        const styles = await page.evaluate(() => {
          const rows = [...document.querySelectorAll("tbody tr")];
          const header = document.querySelector("th")!;
          const hs = getComputedStyle(header);
          const numeric = getComputedStyle(rows[0]!.querySelectorAll("td")[1]!);
          return {
            borders: rows
              .flatMap((row) => [row, ...row.querySelectorAll("td")])
              .map((e) => {
                const s = getComputedStyle(e);
                return [s.borderBottomWidth, s.borderBottomStyle];
              }),
            backgrounds: rows.map((row) => getComputedStyle(row).backgroundColor),
            cells: rows.flatMap((row) => [...row.querySelectorAll("td")]).map((cell) => getComputedStyle(cell).backgroundColor),
            headerColor: hs.color,
            muted: getComputedStyle(document.getElementById("muted-probe")!).color,
            weight: hs.fontWeight,
            headerSize: parseFloat(hs.fontSize),
            bodySize: parseFloat(getComputedStyle(rows[0]!.querySelector("td")!).fontSize),
            headerBorders: [header.parentElement!, ...document.querySelectorAll("th")].map((e) => {
              const s = getComputedStyle(e);
              return [s.borderBottomWidth, s.borderBottomStyle];
            }),
            align: numeric.textAlign,
            figures: numeric.fontVariantNumeric,
          };
        });
        for (const [width, style] of [...styles.borders, ...styles.headerBorders]) expect(noBorder(width!, style!)).toBe(true);
        expect(styles.backgrounds[0]).toBe(styles.backgrounds[1]);
        for (const color of [...styles.backgrounds, ...styles.cells]) expect(transparent(color)).toBe(true);
        expect(styles.headerColor).toBe(styles.muted);
        expect(styles.weight).toBe("500");
        expect(styles.headerSize).toBeLessThan(styles.bodySize);
        expect(styles.align).toBe("right");
        expect(styles.figures).toContain("tabular-nums");
        for (const row of (await geometry(page)).rows) expect(row.height).toBe(44);
        await page.locator("tbody tr").first().hover();
        const hover = await page
          .locator("tbody tr")
          .first()
          .evaluate((row) => getComputedStyle(row).backgroundColor);
        expect(transparent(hover)).toBe(false);
      } finally {
        await page.context().close();
      }
    });

    test("the automatic hairline threshold is strictly greater than eight columns", async () => {
      for (const count of [6, 8, 9]) {
        const page = await load(theme, `columns=${count}`);
        try {
          const borders = await page.locator("tbody tr").evaluateAll((rows) =>
            rows.map((row) => {
              const s = getComputedStyle(row);
              return { width: s.borderBottomWidth, style: s.borderBottomStyle };
            }),
          );
          for (const [i, border] of borders.entries()) {
            if (count === 9 && i < borders.length - 1) expect(border).toEqual({ width: "1px", style: "solid" });
            else expect(noBorder(border.width, border.style)).toBe(true);
          }
        } finally {
          await page.context().close();
        }
      }
    });

    test("loading and real rows share geometry in normal and compact density", async () => {
      for (const [density, height] of [
        ["normal", 44],
        ["compact", 40],
      ] as const) {
        const page = await load(theme, `loading=1${density === "compact" ? "&compact=1" : ""}`);
        try {
          const before = await geometry(page);
          for (const row of before.rows) expect(row.height).toBe(height);
          await page.evaluate("window.showRows()");
          await page.waitForFunction(() => !document.querySelector("[data-loading]"));
          const after = await geometry(page);
          expect(after.rows.map((r) => r.height)).toEqual(before.rows.map((r) => r.height));
          expect(after.table.y).toBe(before.table.y);
          expect(after.rows[0]).toEqual(before.rows[0]);
        } finally {
          await page.context().close();
        }
      }
    });
  });
