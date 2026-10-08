import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { renderHelpMarkdown, renderMarkdownSync } from "../shared/markdown";

// Cloud's rendered Markdown sits inside `MarkdownView` in Help, legal pages,
// announcements and dialogs. Which rule wins there is decided by the compiled
// global stylesheet, so a real engine computes the styles.
let browser: Browser;
let css: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const source = [
  "See the [site plan](https://example.com/plan).",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "| Room | Area |",
  "| --- | --: |",
  "| Hall | 42 |",
  "",
  "| Shelf | Items |",
  "| --- | --: |",
  "| A | 12 |",
].join("\n");

for (const theme of ["light", "dark"] as const) {
  test(`Cloud Markdown in MarkdownView stays calm and readable in ${theme}`, async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<html class="${theme === "dark" ? "dark" : ""}"><head><style>${css}</style></head><body class="k2b-ui">` +
          `<i id="muted" style="background: var(--ui-surface-muted)"></i><i id="surface" style="background: var(--k2b-surface)"></i>` +
          `<div id="plain" class="k2b-content-markdown">${renderMarkdownSync(source)}</div>` +
          `<div class="k2b-panel-dialog__section-body"><div id="group" class="k2b-content-markdown">${renderMarkdownSync(source)}</div></div>` +
          `<div id="help" class="k2b-content-markdown help-document">${renderHelpMarkdown(source)}</div>` +
          `</body></html>`,
      );
      const result = await page.evaluate(() => {
        const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
        const tables = Array.from(document.querySelectorAll("#plain .md-table-wrap"), (wrap) => wrap.getBoundingClientRect());
        const code = (host: string) => {
          const pre = style(`${host} .md-code-block pre`);
          return { fill: pre.backgroundColor, ring: pre.boxShadow, edge: pre.borderTopColor };
        };
        return {
          muted: style("#muted").backgroundColor,
          surface: style("#surface").backgroundColor,
          link: style("#plain a.md-link-widget").textDecorationLine,
          plain: code("#plain"),
          group: code("#group"),
          help: code("#help"),
          tableGap: tables[1]!.top - tables[0]!.bottom,
          fontSize: Number.parseFloat(style("#plain").fontSize),
        };
      });
      const frameless = (fill: string) => ({ fill, ring: "none", edge: "rgba(0, 0, 0, 0)" });
      expect({
        link: result.link,
        plain: result.plain,
        help: result.help,
        group: result.group,
        separated: result.tableGap >= result.fontSize - 0.5,
      }).toEqual({
        // The widget's brackets, weight and icon mark it as a link, as in Assistant chat.
        link: "none",
        // Code blocks are a fill without a frame everywhere, Help included.
        plain: frameless(result.muted),
        help: frameless(result.muted),
        // On a tinted group the fill follows `--k2b-field-surface`, so the block keeps an edge.
        group: frameless(result.surface),
        // Two tables in a row keep the prose block spacing, so they do not read as one.
        separated: true,
      });
    } finally {
      await page.close();
    }
  }, 30_000);
}

// One width system: the table bleeds half a column gap past the prose, every
// cell pads its text by the same amount, so the header line, the row lines, a
// row's hover fill and a column's band all span the same width, and each
// band reaches the same distance past its text on every side.
const tableSource = [
  "Für die nächsten Wochen planen wir drei feste Formate.",
  "",
  "| Format | Wann | Dauer |",
  "| --- | --- | --: |",
  "| Firmen-Reel | Mi, 18:00 | 30 min |",
  "| Rückblick | Sa, 11:00, optional zusätzlich Mo | 45 min |",
  "",
  "Danach folgt die Abstimmung.",
].join("\n");

test("Markdown table lines, row hover and column bands share one width", async () => {
  const page = await browser.newPage({ viewport: { width: 720, height: 900 } });
  try {
    await page.setContent(
      `<html lang="de"><head><meta charset="utf-8"><style>${css}</style></head><body class="k2b-ui" style="margin:0;padding:24px">` +
        `<div id="plain" class="k2b-content-markdown">${renderMarkdownSync(tableSource)}</div>` +
        `<div id="help" class="k2b-content-markdown help-document">${renderHelpMarkdown(tableSource)}</div>` +
        `<div id="assistant" class="assistant-markdown-block">${renderMarkdownSync(tableSource)}</div>` +
        `</body></html>`,
    );
    for (const host of ["#plain", "#help", "#assistant"]) {
      const measure = () =>
        page.evaluate((host) => {
          // `+ 0` turns WebKit's sub-pixel `-0` into `0`.
          const round = (value: number) => Math.round(value * 10) / 10 + 0;
          const wrap = document.querySelector(`${host} .md-table-wrap`)!;
          const box = wrap.getBoundingClientRect();
          // The span owns the text's padding; the cell box is the column band.
          const text = (cell: Element) => {
            const span = cell.querySelector(":scope > .md-table-cell")!;
            const style = getComputedStyle(span);
            const rect = span.getBoundingClientRect();
            return {
              left: rect.left + Number.parseFloat(style.paddingLeft),
              right: rect.right - Number.parseFloat(style.paddingRight),
              top: rect.top + Number.parseFloat(style.paddingTop),
              bottom: rect.bottom - Number.parseFloat(style.paddingBottom),
            };
          };
          const rows = Array.from(wrap.querySelectorAll("tr"));
          const cells = rows.flatMap((row) => Array.from(row.children));
          const prose = document.querySelector(`${host} p`)!.getBoundingClientRect();
          const header = rows[0]!.children;
          const lastRow = rows.at(-1)!.children[0]!;
          return {
            // Lines sit on the rows, the row hover fills the row: both span the wrapper.
            rows: rows.map((row) => {
              const rect = row.getBoundingClientRect();
              return [round(rect.left - box.left), round(box.right - rect.right)];
            }),
            lines: [getComputedStyle(rows[0]!).borderBottomWidth, getComputedStyle(rows[1]!).borderBottomWidth],
            // A column band is its cell box: the text plus the same reach on both sides.
            bands: cells.map((cell) => {
              const rect = cell.getBoundingClientRect();
              const inner = text(cell);
              const after = getComputedStyle(cell, "::after");
              return [round(inner.left - rect.left), round(rect.right - inner.right), after.left, after.right];
            }),
            above: round(text(header[0]!).top - box.top),
            below: round(box.bottom - text(lastRow).bottom),
            bleed: [round(prose.left - box.left), round(box.right - prose.right)],
            flush: [round(text(header[0]!).left - prose.left), round(prose.right - text(header[header.length - 1]!).right)],
            layout: cells.map((cell) => {
              const rect = cell.getBoundingClientRect();
              // Page coordinates: hovering may scroll the page into view.
              return [rect.x + window.scrollX, rect.y + window.scrollY, rect.width, rect.height];
            }),
            next: wrap.nextElementSibling!.getBoundingClientRect().top + window.scrollY,
          };
        }, host);
      await page.mouse.move(0, 0);
      const idle = await measure();
      expect({ host, ...idle, layout: undefined, next: undefined }).toEqual({
        host,
        rows: idle.rows.map(() => [0, 0]),
        lines: ["1px", "1px"],
        bands: idle.bands.map(() => [8, 8, "0px", "0px"]),
        // The band reaches as far above the header and below the last row as to the sides.
        above: 8,
        below: 8,
        bleed: [8, 8],
        flush: [0, 0],
        layout: undefined,
        next: undefined,
      });
      // Hovering a cell fills its row and column without moving anything.
      const cell = page.locator(`${host} tbody tr`).last().locator("td").nth(1);
      await cell.hover();
      const fills = await cell.evaluate((element) => [
        getComputedStyle(element.parentElement!).backgroundColor,
        getComputedStyle(element, "::after").backgroundColor,
      ]);
      for (const fill of fills) expect(fill).not.toBe("rgba(0, 0, 0, 0)");
      const hovered = await measure();
      expect(hovered.layout).toEqual(idle.layout);
      expect(hovered.next).toBe(idle.next);
    }
  } finally {
    await page.close();
  }
}, 30_000);
