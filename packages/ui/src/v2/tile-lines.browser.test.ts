import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

// Cards that carry their own lines and share a row, as the server sends them, at a phone, a laptop and a large screen.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-tile-lines-browser-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Tiles } = await import("./layout");
const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss = "html, body { margin: 0; } .frame { width: 100%; } .ti { display: inline-block; width: 1em; height: 1em; }";

const way = (title: string, pages: number) => ({
  icon: "book",
  title,
  meta: "Kapitel, Abläufe und Ansprechpersonen",
  href: `#${title}`,
  stats: [{ icon: "files", label: `${pages} Seiten` }],
  lines: [
    { text: title },
    { text: "Wareneingang" },
    { text: "Annahme prüfen", level: 1 },
    { text: "Kühlware und Tiefkühlware mit Temperaturprotokoll und Rückweisung bei Abweichung", level: 2 },
  ],
  linesMore: `+${pages - 4} weitere Seiten`,
});
const markup = renderToString(() =>
  createComponent(Tiles, {
    variant: "card",
    perRow: 3,
    label: "Womit beginnt dein Notizbuch?",
    items: [way("Leeres Notizbuch", 5), way("Besprechungen", 6), way("Handbuch", 9)],
  }),
);

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, forcedColors = false): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  if (forcedColors) await page.emulateMedia({ forcedColors: "active" });
  await page.setContent(
    `<!doctype html><html lang="de"><head><style>${css}</style><style>${testCss}</style></head>` +
      `<body class="k2-ui"><div class="frame">${markup}</div></body></html>`,
  );
  await settled(page);
  return page;
};

/** Where each card and its lines stand. */
const measure = (page: Page) =>
  page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".k2-tiles")!.getBoundingClientRect();
    const cards = [...document.querySelectorAll<HTMLElement>(".k2-tiles > .k2-tile")].map((card) => {
      const box = card.getBoundingClientRect();
      const lines = [...card.querySelectorAll<HTMLElement>(".k2-tile-line")].map((line) => {
        const text = document.createRange();
        text.selectNodeContents(line);
        return {
          start: Math.round(text.getBoundingClientRect().left - box.left),
          cut: line.scrollWidth > line.clientWidth,
          ellipsis: getComputedStyle(line).textOverflow === "ellipsis",
          inside: line.getBoundingClientRect().right <= box.right + 0.5,
          visible: line.getBoundingClientRect().height > 0 && getComputedStyle(line).visibility === "visible",
        };
      });
      return { top: Math.round(box.top), left: Math.round(box.left), width: Math.round(box.width), lines };
    });
    return { width: Math.round(grid.width), cards };
  });

for (const width of [1440, 1920]) {
  test(`${width}: three cards share the row, and their lines stand in tree order inside them`, async () => {
    const page = await open(width);
    try {
      const { cards } = await measure(page);
      // one row: the same top, together across the width
      expect(new Set(cards.map((card) => card.top)).size).toBe(1);
      expect(cards.every((card) => card.width > (width - 80) / 3 - 24)).toBe(true);
      for (const card of cards) {
        expect(card.lines).toHaveLength(5);
        // each level one step further in, the more line back at the start
        const [first, second, child, grandchild, more] = card.lines;
        expect(second!.start).toBe(first!.start);
        expect(child!.start).toBeGreaterThan(first!.start);
        expect(grandchild!.start - child!.start).toBe(child!.start - first!.start);
        expect(more!.start).toBe(first!.start);
        expect(card.lines.every((line) => line.inside && line.ellipsis)).toBe(true);
      }
    } finally {
      await page.close();
    }
  });
}

test("390: cards keep their 240 px and stand one under another; a long line is cut with an ellipsis inside the card", async () => {
  const page = await open(390);
  try {
    const { cards } = await measure(page);
    expect(new Set(cards.map((card) => card.top)).size).toBe(3);
    expect(cards.every((card) => card.width >= 240)).toBe(true);
    const long = cards[0]!.lines[3]!;
    expect(long.cut).toBe(true);
    expect(long.ellipsis).toBe(true);
    expect(long.inside).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await page.close();
  }
});

test("right to left, a deeper line steps in from the right edge", async () => {
  const page = await open(1440);
  try {
    await page.evaluate(() => {
      document.documentElement.dir = "rtl";
    });
    await settled(page);
    const ends = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>(".k2-tiles > .k2-tile")!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>(".k2-tiles > .k2-tile:first-child .k2-tile-line")].map((line) => {
        const text = document.createRange();
        text.selectNodeContents(line);
        return Math.round(card.right - text.getBoundingClientRect().right);
      });
    });
    expect(ends[2]!).toBeGreaterThan(ends[0]!);
    expect(ends[1]).toBe(ends[0]);
  } finally {
    await page.close();
  }
});

test("with forced colours the lines stay visible and inside their cards", async () => {
  const page = await open(1440, true);
  try {
    const { cards } = await measure(page);
    const lines = cards.flatMap((card) => card.lines);
    expect(lines).toHaveLength(15);
    expect(lines.every((line) => line.visible && line.inside)).toBe(true);
  } finally {
    await page.close();
  }
});
