import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";

// Segment widths, the limit mark and wrapping are layout, which only a real engine renders.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-budget-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { BudgetList } = await import("./BudgetList");
const { BalanceSummary } = await import("../content/BalanceSummary");
const { LocaleProvider } = await import("../intl/locale");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const markup = renderToString(() =>
  createComponent(LocaleProvider, {
    locale: "de",
    get children() {
      return [
        createComponent(BudgetList, {
          currency: "EUR",
          items: [
            { label: "Wareneinkauf", used: 9000, expected: 3000, limit: 15000 },
            { label: "Reisen", used: 900, expected: 300, limit: 1000 },
          ],
        }),
        createComponent(BalanceSummary, { start: 1_218_800, in: 1_229_260, out: 1_229_520, currency: "EUR", decimals: 2 }),
      ];
    },
  }),
);

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const measure = () =>
  Array.from(document.querySelectorAll(".k2b-budget__row")).map((row) => {
    const track = row.querySelector(".k2b-progress__track")!.getBoundingClientRect();
    const parts = Array.from(row.querySelectorAll<HTMLElement>(".k2b-progress__segment")).map((part) => ({
      pattern: part.dataset.pattern,
      share: Math.round((part.getBoundingClientRect().width / track.width) * 1000) / 10,
    }));
    const mark = row.querySelector(".k2b-progress__limit")?.getBoundingClientRect();
    return {
      trackHeight: Math.round(track.height),
      hintHeight: Math.round(row.querySelector(".k2b-budget__hint")!.getBoundingClientRect().height),
      parts,
      // Where the limit mark sits along the track, and how far it reaches above and below it.
      mark: mark ? { at: Math.round(((mark.left + mark.width / 2 - track.left) / track.width) * 1000) / 10, reach: Math.round(mark.height - track.height) } : null,
    };
  });

describe("@k2b/ui budgets and balance rows", () => {
  for (const [name, width] of [
    ["desktop", 1440],
    ["phone", 390],
  ] as const) {
    test(`on a ${name} segments fill their share, an overrun gets a mark, and nothing overflows`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.setContent(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
            `<body class="k2b-ui" style="margin:0;padding:12px;max-width:560px">${markup}</body></html>`,
        );
        await settled(page);
        const [within, over] = await page.evaluate(measure);
        expect(within).toEqual({
          trackHeight: 8,
          hintHeight: 18,
          parts: [
            { pattern: "solid", share: 60 },
            { pattern: "hatched", share: 20 },
          ],
          mark: null,
        });
        expect(over!.parts.map((part) => part.pattern)).toEqual(["solid", "hatched", "over"]);
        expect(over!.parts.map((part) => part.share)).toEqual([75, 8.3, 16.7]);
        expect(over!.mark).toEqual({ at: 83.3, reach: 6 });
        // A long balance line wraps instead of widening the page.
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
        const lines = await page.evaluate(() => {
          const parts = Array.from(document.querySelectorAll(".k2b-balance > *")).map((part) => Math.round(part.getBoundingClientRect().top));
          return new Set(parts).size;
        });
        if (name === "phone") expect(lines).toBeGreaterThan(1);
      } finally {
        await page.close();
      }
    });
  }
});
