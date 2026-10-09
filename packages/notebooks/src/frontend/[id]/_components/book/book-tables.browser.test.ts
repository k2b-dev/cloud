import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../../../ui/test/browser";
import { renderNotebookBook } from "../../../../lib/book-renderer";
import type { NoteQueryResult } from "../../../../service/note-query";

// Book view links the app's stylesheet before Cloud's global one, so the
// table geometry is decided by the shipped cascade, not by the source.
let browser: Browser;
let css: string;
beforeAll(async () => {
  const stylesheets = [resolve(import.meta.dir, "../../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../../styles.css")];
  const outputs = await Promise.all(
    stylesheets.map(async (entry) => {
      const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
      if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}.`);
      return build.outputs[0]!.text();
    }),
  );
  css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const queryResult: NoteQueryResult = {
  columns: ["$title", "$tags"],
  items: [
    {
      id: "DEF456",
      title: "Redaktionsplan",
      href: "/app/notebooks/book01/notes/DEF456",
      values: { $title: "Redaktionsplan", $tags: ["Team/Social"] },
    },
    {
      id: "DEF457",
      title: "Rückblick",
      href: "/app/notebooks/book01/notes/DEF457",
      values: { $title: "Rückblick", $tags: ["Team/Archiv"] },
    },
  ],
  total: 2,
  limit: 50,
  truncated: false,
  diagnostics: [],
};

const open = async (markdown: string, width: number) => {
  const { html } = renderNotebookBook({
    markdown,
    notebookId: "book01",
    locale: "de",
    queryResults: new Map([[1, queryResult]]),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.setContent(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style></head><body class="k2b-ui" style="margin:0"><article class="notebook-book-content">${html}</article></body></html>`,
  );
  return page;
};

/** Where the lines, the row fill and each column band reach relative to the text and the prose. */
const measure = (page: Page, index: number) =>
  page.evaluate((index) => {
    // `+ 0` turns WebKit's sub-pixel `-0` into `0`.
    const round = (value: number) => Math.round(value * 10) / 10 + 0;
    const wrap = document.querySelectorAll(".notebook-book-content .md-table-wrap")[index]!;
    const box = wrap.getBoundingClientRect();
    // Markdown cells pad their text in a span; query cells pad it themselves.
    const text = (cell: Element) => {
      const owner = cell.querySelector(":scope > .md-table-cell") ?? cell;
      const style = getComputedStyle(owner);
      const rect = owner.getBoundingClientRect();
      return {
        left: rect.left + Number.parseFloat(style.paddingLeft),
        right: rect.right - Number.parseFloat(style.paddingRight),
        top: rect.top + Number.parseFloat(style.paddingTop),
        bottom: rect.bottom - Number.parseFloat(style.paddingBottom),
      };
    };
    const rows = Array.from(wrap.querySelectorAll("tr"));
    const cells = rows.flatMap((row) => Array.from(row.children));
    const prose = document.querySelector(".notebook-book-content > p")!.getBoundingClientRect();
    const header = rows[0]!.children;
    return {
      rows: rows.map((row) => {
        const rect = row.getBoundingClientRect();
        return [round(rect.left - box.left), round(box.right - rect.right)];
      }),
      bands: cells.map((cell) => {
        const rect = cell.getBoundingClientRect();
        const inner = text(cell);
        return [round(inner.left - rect.left), round(rect.right - inner.right)];
      }),
      above: round(text(header[0]!).top - box.top),
      below: round(box.bottom - text(rows.at(-1)!.children[0]!).bottom),
      bleed: [round(prose.left - box.left), round(box.right - prose.right)],
      flush: [round(text(header[0]!).left - prose.left), round(prose.right - text(header[header.length - 1]!).right)],
      layout: cells.map((cell) => {
        const rect = cell.getBoundingClientRect();
        // Page coordinates: hovering may scroll the page into view.
        return [rect.x + window.scrollX, rect.y + window.scrollY, rect.width, rect.height];
      }),
    };
  }, index);

const prose = "Für die nächsten Wochen planen wir drei feste Formate.";
const table = [
  "| Format | Wann | Dauer |",
  "| --- | --- | --: |",
  "| Firmen-Reel | Mi, 18:00 | 30 min |",
  "| Rückblick | Sa, 11:00 | 45 min |",
].join("\n");
const query = ":::query\nsource: notes\ncolumns:\n  - $title\n  - $tags\n:::";

test("Book tables give lines, row hover and column bands one width", async () => {
  const page = await open(`${query}\n\n${prose}\n\n${table}`, 720);
  try {
    // The query table first, then the Markdown table.
    for (const index of [0, 1]) {
      const idle = await measure(page, index);
      expect({ ...idle, layout: undefined }).toEqual({
        rows: idle.rows.map(() => [0, 0]),
        bands: idle.bands.map(() => [8, 8]),
        above: 8,
        below: 8,
        bleed: [8, 8],
        flush: [0, 0],
        layout: undefined,
      });
      const cell = page.locator(".notebook-book-content .md-table-wrap").nth(index).locator("tbody tr").last().locator("td").last();
      await cell.hover();
      const fills = await cell.evaluate((element) => [
        getComputedStyle(element.parentElement!).backgroundColor,
        getComputedStyle(element, "::after").backgroundColor,
      ]);
      for (const fill of fills) expect(fill).not.toBe("rgba(0, 0, 0, 0)");
      expect((await measure(page, index)).layout).toEqual(idle.layout);
      await page.mouse.move(0, 0);
    }
  } finally {
    await page.close();
  }
});

test("a wide Book table scrolls in itself on a phone, bleed included, and the page does not", async () => {
  const columns = Array.from({ length: 16 }, (_, index) => `Spalte${index + 1}`);
  const wide = [`| ${columns.join(" | ")} |`, `|${" --- |".repeat(16)}`, `|${" 12.400 |".repeat(16)}`].join("\n");
  const page = await open(`${prose}\n\n${wide}`, 360);
  try {
    const scroll = await page.evaluate(() => {
      const wrap = document.querySelector(".notebook-book-content .md-table-wrap")!;
      wrap.scrollLeft = wrap.scrollWidth;
      const box = wrap.getBoundingClientRect();
      const prose = document.querySelector(".notebook-book-content > p")!.getBoundingClientRect();
      const last = wrap.querySelector("tbody td:last-child")!.getBoundingClientRect();
      return {
        scrolls: wrap.scrollWidth > wrap.clientWidth,
        bleed: [Math.round(prose.left - box.left), Math.round(box.right - prose.right)],
        // Scrolled to the end, the last column keeps its band past the text.
        end: Math.abs(Math.round(box.right - last.right)),
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(scroll).toEqual({ scrolls: true, bleed: [8, 8], end: 0, page: 0 });
  } finally {
    await page.close();
  }
});

test("a short first column keeps its words whole next to a long second column", async () => {
  const long =
    "Ein eigener Arbeitsbereich in der Cloud, etwa Rechnungen oder Zahlungen. Alle Apps arbeiten mit denselben Daten und öffnen sich nur mit der passenden Berechtigung.";
  const glossary = [
    "| Begriff | Bedeutung |",
    "| --- | --- |",
    ...["App", "Mein Bereich", "Personal", "Rechnungen", "Zahlungen", "Verwaltung"].map((term) => `| **${term}** | ${long} |`),
  ].join("\n");
  for (const width of [1280, 390]) {
    const page = await open(glossary, width);
    try {
      // A word split across lines has more than one client rect.
      const broken = await page.evaluate(() => {
        const split: string[] = [];
        for (const cell of document.querySelectorAll(".notebook-book-content :is(th, td):first-child")) {
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.textContent ?? "";
            for (const match of text.matchAll(/\S+/g)) {
              const range = document.createRange();
              range.setStart(node, match.index);
              range.setEnd(node, match.index + match[0].length);
              if (range.getClientRects().length > 1) split.push(match[0]);
            }
          }
        }
        return split;
      });
      expect({ width, broken }).toEqual({ width, broken: [] });
    } finally {
      await page.close();
    }
  }
});
