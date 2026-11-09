import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { hoverInPlace, launchBrowser, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "data-table-lines.fixture.ts");
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
  const [selected, setSelected] = createSignal(null);
  window.showRows = () => setLoading(false);
  window.select = (id) => setSelected(id);
  return createComponent(DataTable, {
    columns, get rows() { return loading() ? [] : rows; }, get loading() { return loading(); },
    getRowId: (row) => row.name, get selectedRowId() { return selected(); },
    loadingRows: 3, hoverRows: true, surface: 'plain', density: params.has('compact') ? 'compact' : 'normal',
    fillHeight: params.has('fill'), class: params.has('fill') ? 'fill-frame' : undefined,
  });
}, document.getElementById('app'));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the table lines fixture");
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
    `<!doctype html><html><head><style>${css}</style></head><style>.fill-frame{height:400px}</style><body class="k2b-ui" data-theme="${theme}"><div id="app"></div><span id="probe-secondary" style="color:var(--k2b-text-secondary)"></span><span id="probe-muted" style="background:var(--k2b-surface-muted)"></span><span id="probe-strong" style="color:var(--k2b-border-strong)"></span><span id="probe-border" style="color:var(--k2b-border)"></span><span id="probe-action" style="color:var(--k2b-app-workspace-active)"></span><span id="probe-surface" style="background:var(--k2b-surface)"></span></body></html>`,
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
const transparent = (color: string) => ["transparent", "rgba(0, 0, 0, 0)"].includes(color);
// Computed colors may serialize as color(srgb …); a canvas turns each into "r,g,b,a".
const paints = (page: Page) =>
  page.evaluate(() => {
    const context = document.createElement("canvas").getContext("2d")!;
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].join();
    };
    const probe = (id: string, property: "color" | "backgroundColor") => rgba(getComputedStyle(document.getElementById(id)!)[property]);
    const cell = (element: Element) => {
      const s = getComputedStyle(element);
      // Inset shadows serialize as "<color> <x> <y> <blur> <spread> inset"; keep color and offsets.
      const lines = [...s.boxShadow.matchAll(/(rgba?\([^)]*\)|color\([^)]*\)) (-?\d+)px (-?\d+)px/g)].map(
        ([, color, x, y]) => `${x},${y}:${rgba(color!)}`,
      );
      return {
        background: rgba(s.backgroundColor),
        lines,
        border: [s.borderTopWidth, s.borderBottomWidth, s.borderLeftWidth, s.borderRightWidth],
      };
    };
    const head = [...document.querySelectorAll("thead th")];
    const rows = [...document.querySelectorAll("tbody tr.k2b-data-table__row")];
    return {
      secondary: probe("probe-secondary", "color"),
      muted: probe("probe-muted", "backgroundColor"),
      strong: probe("probe-strong", "color"),
      border: probe("probe-border", "color"),
      action: probe("probe-action", "color"),
      surface: probe("probe-surface", "backgroundColor"),
      headColor: rgba(getComputedStyle(head[0]!).color),
      headWeight: getComputedStyle(head[0]!).fontWeight,
      head: head.map(cell),
      rows: rows.map((row) => ({
        background: rgba(getComputedStyle(row).backgroundColor),
        cells: [...row.querySelectorAll("td")].map(cell),
      })),
    };
  });
const boxes = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("table, th, td, tr")].map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height].join();
    }),
  );
const rgbOf = (value: string) => value.split(",").slice(0, 3).map(Number);

for (const theme of ["light", "dark"])
  describe(`table lines in ${theme}`, () => {
    test("a grey head with a strong line, a line under each row but the last, and lighter column lines", async () => {
      const page = await load(theme);
      try {
        await page.waitForSelector("tbody tr.k2b-data-table__row");
        await settled(page);
        const p = await paints(page);
        const column = (line: string) => line.startsWith("1,0:");
        expect(p.headColor).toBe(p.secondary);
        expect(p.headWeight).toBe("600");
        for (const [i, th] of p.head.entries()) {
          expect(th.background).toBe(p.muted);
          expect(th.lines).toContain(`0,-1:${p.strong}`);
          expect(th.lines.some(column)).toBe(i > 0);
          // Lines are shadows inside the cell; no cell gets a border that could change its size.
          expect(th.border).toEqual(["0px", "0px", "0px", "0px"]);
        }
        for (const [r, row] of p.rows.entries()) {
          expect(transparent(row.background) || row.background.endsWith(",0")).toBe(true);
          for (const [i, td] of row.cells.entries()) {
            expect(td.lines.includes(`0,-1:${p.border}`), `row ${r} line`).toBe(r < p.rows.length - 1);
            const columnLine = td.lines.find(column);
            if (i === 0) expect(columnLine).toBeUndefined();
            else {
              // 70 % of the row line: lighter than it, still visible.
              expect(columnLine).toBeDefined();
              expect(columnLine).not.toBe(`1,0:${p.border}`);
            }
            expect(td.border).toEqual(["0px", "0px", "0px", "0px"]);
          }
        }
        const { rows } = await geometry(page);
        for (const row of rows) expect(row.height).toBe(44);
        const head = await page
          .locator("thead th")
          .first()
          .evaluate((th) => th.getBoundingClientRect().height);
        expect(head).toBe(34);
      } finally {
        await page.context().close();
      }
    });

    test("row hover, column hover and selection change only fills, never a box or a line", async () => {
      const page = await load(theme);
      try {
        await page.waitForSelector("tbody tr.k2b-data-table__row");
        await settled(page);
        await page.mouse.move(1400, 880);
        await settled(page);
        const rest = await paints(page);
        const restBoxes = await boxes(page);

        // Column hover: the head cell gets darker than the grey head, body cells a light grey, not the blue hover.
        await hoverInPlace(page.locator("tbody tr").nth(1).locator("td").nth(1));
        await page.waitForSelector('th[data-highlighted="true"]');
        await settled(page);
        const hovered = await paints(page);
        expect(await boxes(page)).toEqual(restBoxes);
        const headFill = rgbOf(hovered.head[1]!.background);
        const headRest = rgbOf(rest.head[1]!.background);
        const darker = theme === "light" ? headFill[0]! < headRest[0]! : headFill[0]! > headRest[0]!;
        expect(darker).toBe(true);
        expect(hovered.head[0]!.background).toBe(rest.head[0]!.background);
        const cell = rgbOf(hovered.rows[0]!.cells[1]!.background);
        expect(cell[0]).toBe(cell[2]);
        expect(hovered.rows[1]!.background).not.toBe(rest.rows[1]!.background);
        for (const [r, row] of hovered.rows.entries())
          for (const [i, td] of row.cells.entries()) expect(td.lines).toEqual(rest.rows[r]!.cells[i]!.lines);

        // Selection: a fill of 16 % app colour on the row, the same lines and boxes as before.
        await page.mouse.move(1400, 880);
        await page.evaluate("window.select('Beta')");
        await page.waitForSelector('tr[data-selected="true"]');
        await settled(page);
        const selected = await paints(page);
        expect(await boxes(page)).toEqual(restBoxes);
        const fill = rgbOf(selected.rows[1]!.background);
        const action = rgbOf(selected.action);
        const surface = rgbOf(selected.surface);
        fill.forEach((channel, i) => expect(Math.abs(channel - (action[i]! * 0.16 + surface[i]! * 0.84))).toBeLessThanOrEqual(1.5));
        for (const [r, row] of selected.rows.entries())
          for (const [i, td] of row.cells.entries()) {
            expect(td.lines, `row ${r} cell ${i}`).toEqual(rest.rows[r]!.cells[i]!.lines);
            expect(td.lines.some((line) => line.endsWith(selected.action))).toBe(false);
          }

        // Column hover over the selected row keeps the row's own fill.
        await hoverInPlace(page.locator("tbody tr").nth(1).locator("td").nth(1));
        await page.waitForSelector('th[data-highlighted="true"]');
        await settled(page);
        const both = await paints(page);
        expect(transparent(both.rows[1]!.cells[1]!.background) || both.rows[1]!.cells[1]!.background.endsWith(",0")).toBe(true);
        expect(await boxes(page)).toEqual(restBoxes);
      } finally {
        await page.context().close();
      }
    });

    test("nine columns draw the same lines as six", async () => {
      const lines = async (count: number) => {
        const page = await load(theme, `columns=${count}`);
        try {
          await page.waitForSelector("tbody tr.k2b-data-table__row");
          await settled(page);
          await settled(page);
          return (await paints(page)).rows.map((row) => row.cells[1]!.lines);
        } finally {
          await page.context().close();
        }
      };
      expect(await lines(9)).toEqual(await lines(6));
    });

    test("a fill-height table keeps its rows at their height and gives the spare room to the spacer", async () => {
      for (const [density, height] of [
        ["normal", 44],
        ["compact", 40],
      ] as const) {
        const page = await load(theme, `fill=1${density === "compact" ? "&compact=1" : ""}`);
        try {
          await settled(page);
          const rows = await page
            .locator("tbody tr.k2b-data-table__row")
            .evaluateAll((items) => items.map((row) => row.getBoundingClientRect().height));
          expect(rows).toEqual([height, height, height]);
          const spacer = await page.locator("td.k2b-data-table__fill").evaluate((cell) => cell.getBoundingClientRect().height);
          expect(spacer).toBeGreaterThan(100);
        } finally {
          await page.context().close();
        }
      }
    });

    test("a loading fill-height table keeps row heights when its rows arrive and announces the wait politely", async () => {
      const page = await load(theme, "fill=1&loading=1");
      try {
        await settled(page);
        const rows = () =>
          page.locator("tbody tr.k2b-data-table__row").evaluateAll((items) => items.map((row) => row.getBoundingClientRect().height));
        expect(await rows()).toEqual([44, 44, 44]);
        await page.waitForFunction(() =>
          document.querySelector('[data-k2b-live] [aria-live="polite"]')?.textContent?.includes("Loading rows"),
        );
        await page.evaluate("window.showRows()");
        await page.waitForFunction(() => !document.querySelector("[data-loading]"));
        expect(await rows()).toEqual([44, 44, 44]);
      } finally {
        await page.context().close();
      }
    });

    test("loading and real rows share geometry in normal and compact density", async () => {
      for (const [density, height] of [
        ["normal", 44],
        ["compact", 40],
      ] as const) {
        const page = await load(theme, `loading=1${density === "compact" ? "&compact=1" : ""}`);
        try {
          await settled(page);
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
