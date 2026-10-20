import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "data-table-focus.fixture.ts");
const build = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { DataTable } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const params = new URLSearchParams(location.hash.slice(1));
const columns = Array.from({ length: Number(params.get('columns') || 3) }, (_, i) => ({ id: 'c'+i, header: 'Field '+i, value: 'name' }));
render(() => {
  const [selected, setSelected] = createSignal(null);
  return createComponent(DataTable, {
    rows: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }], columns,
    getRowId: row => row.id, get selectedRowId() { return selected(); },
    onRowClick: row => { setSelected(row.id); document.body.dataset.rowCalls = String(Number(document.body.dataset.rowCalls || 0) + 1); },
    surface: 'plain', hoverRows: true, highlightColumns: true,
    density: params.has('compact') ? 'compact' : 'normal',
    renderCell: ({ row, col, value, render }) => {
      if (col.id === 'c0') { const a = document.createElement('a'); a.href = '#record-'+row.id; a.textContent = row.name; return a; }
      if (col.id === 'c2') { const b = document.createElement('button'); b.textContent = 'Edit'; b.onclick = () => document.body.dataset.cellCalls = String(Number(document.body.dataset.cellCalls || 0) + 1); return b; }
      return render(value);
    },
  });
}, document.getElementById('app'));
`,
  },
  target: "browser",
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle row focus fixture");
const script = await build.outputs[0]!.text();
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

// Read real screenshot pixels: WebKit can compute a TR's inset shadow without
// painting it. Samples cover all cell tops/bottoms and both outer row edges.
const paintedRing = async (page: Page, row: Locator) => {
  const points = await row.evaluate((element) => {
    const r = element.getBoundingClientRect();
    return [
      ...Array.from(element.children).flatMap((cell) => {
        const c = cell.getBoundingClientRect();
        return [
          [c.x + c.width / 2, r.y + 1],
          [c.x + c.width / 2, r.bottom - 2],
        ];
      }),
      [r.x + 1, r.y + r.height / 2],
      [r.right - 2, r.y + r.height / 2],
    ];
  });
  const png = (await page.screenshot()).toString("base64");
  const colors = await page.evaluate(
    async ({ png, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const samples = points.map(([x, y]) => Array.from(context.getImageData(Math.floor(x!), Math.floor(y!), 1, 1).data.slice(0, 3)));
      context.fillStyle = getComputedStyle(document.getElementById("ring-color")!).color;
      context.fillRect(0, 0, 1, 1);
      return { samples, expected: Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3)) };
    },
    { png, points },
  );
  for (const sample of colors.samples)
    expect(
      sample.every((value, i) => Math.abs(value - colors.expected[i]!) <= 12),
      `painted ${sample}; ring ${colors.expected}`,
    ).toBe(true);
};

for (const theme of ["light", "dark"]) {
  for (const [width, columns, compact] of [
    [390, 3, false],
    [900, 9, true],
    [390, 1, false],
  ] as const) {
    test(`row focus paints all edges through hover and selection: ${theme} ${width}px ${columns} columns`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 500 }, deviceScaleFactor: 1 });
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style><style>body{padding:16px;background:var(--k2b-surface)}#app{max-width:800px}</style></head><body class="k2b-ui" data-theme="${theme}"><div id="app"></div><span id="ring-color" style="color:var(--k2b-focus-ring)"></span></body></html>`,
        );
        await page.evaluate(
          (hash) => {
            location.hash = hash;
          },
          `columns=${columns}${compact ? "&compact=1" : ""}`,
        );
        await page.addScriptTag({ content: script });
        const row = page.locator("tbody tr").first();
        const before = await row.boundingBox();
        await page.locator(".k2b-table-wrap").focus();
        await page.keyboard.press("Tab");
        expect(await row.evaluate((e) => e === document.activeElement && e.matches(":focus-visible"))).toBe(true);
        await paintedRing(page, row);
        await row.locator("td").first().hover();
        await paintedRing(page, row);
        await page.keyboard.press("Enter");
        expect(await row.getAttribute("data-selected")).toBe("true");
        expect(await row.boundingBox()).toEqual(before);
        await paintedRing(page, row);
        const output = process.env.DATA_TABLE_FOCUS_SHOTS;
        if (output) {
          mkdirSync(resolve(output, browserName), { recursive: true });
          await page.screenshot({ path: resolve(output, browserName, `row-focus-${theme}-${width}-${columns}.png`) });
        }
        // Links and controls keep their own focus and activation; the row must
        // not handle their keys or retain its ring after focus enters a cell.
        await page.keyboard.press("Tab");
        expect(await row.getByRole("link").evaluate((e) => e === document.activeElement)).toBe(true);
        expect(await row.evaluate((e) => e.matches(":focus-visible"))).toBe(false);
        await page.keyboard.press("Enter");
        expect(new URL(page.url()).hash).toBe("#record-a");
        expect(await page.locator("body").getAttribute("data-row-calls")).toBe("1");
        if (columns > 1) {
          await page.keyboard.press("Tab");
          expect(await row.getByRole("button", { name: "Edit" }).evaluate((e) => e === document.activeElement)).toBe(true);
          await page.keyboard.press("Enter");
          expect(await page.locator("body").getAttribute("data-cell-calls")).toBe("1");
          expect(await page.locator("body").getAttribute("data-row-calls")).toBe("1");
        }
      } finally {
        await page.close();
      }
    });
  }
}
