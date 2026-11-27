import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { measureV2Layout } from "./testing";

// A table in reading text (`Prose` with Markdown, W8's tool output) reads like a small v2 table: its cells stand 12 px
// apart, so "2" and "320,00 €" never read as "2320,00 €"; the head has the type of a Table head; it stands on the text
// edge of the prose; a column the author aligned right (`--:`) holds numbers in tabular figures.

// the Markdown of Prose, rendered as the server renders it (a Solid module, compiled by the registered plugin)
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-prose-table-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { renderSafeMarkdown } = await import("../content/MarkdownView");
const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const markdown = [
  "Die Bestellung für die Werkstatt Nord:",
  "",
  "| Artikel | Menge | Preis |",
  "|---|--:|--:|",
  "| Stuhl Eiche | 2 | 320,00 € |",
  "| Tisch | 1 | 1.250,00 € |",
  "| Lampe | 12 | 89,90 € |",
].join("\n");

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

for (const width of [1440, 390])
  test(`at ${width}: a table in reading text keeps its cells apart, stands on the text edge and reads its head and numbers right`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors = pageErrors(page);
    try {
      await page.setContent(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style></head>` +
          `<body style="margin:0"><div class="k2-ui"><section class="k2-pane" data-k2-part="Pane" aria-label="Ergebnis"><div class="k2-scroll">` +
          `<div class="k2-prose" data-k2-part="Prose" data-k2-prose="">${renderSafeMarkdown(markdown, { locale: "de", allowImages: false })}</div>` +
          "</div></section></div></body></html>",
      );
      await settled(page);
      const found = await page.evaluate(() => {
        const text = (cell: Element) => {
          const range = document.createRange();
          range.selectNodeContents(cell);
          return range.getBoundingClientRect();
        };
        const rows = [...document.querySelectorAll(".k2-prose tr")];
        // the smallest space between the words of two cells side by side, over every row
        const gaps = rows.flatMap((row) => {
          const cells = [...row.children].map(text);
          return cells.slice(1).map((cell, index) => cell.left - cells[index]!.right);
        });
        const paragraph = text(document.querySelector(".k2-prose p")!);
        const head = document.querySelector(".k2-prose th")!;
        const amount = document.querySelector('.k2-prose td[align="right"]')!;
        return {
          gap: Math.round(Math.min(...gaps)),
          edge: Math.round(text(head).left - paragraph.left),
          head: { weight: getComputedStyle(head).fontWeight, size: getComputedStyle(head).fontSize },
          figures: getComputedStyle(amount).fontVariantNumeric,
          right:
            Math.round(text(document.querySelectorAll('.k2-prose tr td[align="right"]')[1]!).right) ===
            Math.round(text(document.querySelectorAll('.k2-prose tr th[align="right"]')[1]!).right),
        };
      });
      expect(found.gap).toBeGreaterThanOrEqual(12);
      expect(found.edge).toBe(0);
      expect(found.head).toEqual({ weight: "500", size: "12px" });
      expect(found.figures).toBe("tabular-nums");
      expect(found.right).toBe(true);
      expect((await measureV2Layout(page)).problems).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
