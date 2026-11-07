import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";

// Whether an amount fits its key figure tile is layout, which only a real engine renders.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-flow-amount-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { FlowAmount } = await import("./FlowAmount");
const { StatCell } = await import("../surfaces/StatCell");
const { StatGrid } = await import("../surfaces/StatGrid");
const { LocaleProvider } = await import("../intl/locale");
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

test("a money tile keeps its amount whole from a phone to a desktop", async () => {
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(StatGrid, {
          size: "lg",
          columns: 4,
          get children() {
            return [29260, -29520, 1_204_381, -2380].map((value, index) =>
              createComponent(StatCell, {
                label: `Money ${index + 1}`,
                icon: "ti ti-arrow-down-left",
                tone: value > 0 ? "in" : "out",
                value: createComponent(FlowAmount, { value, currency: "EUR", decimals: 0, size: "lg" }),
                delta: { value: 0.065, better: "up" },
              }),
            );
          },
        });
      },
    }),
  );
  for (const [width, frame] of [
    [390, 300],
    [390, 366],
    [320, 296],
    [1440, 1384],
  ] as const) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.setContent(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
          `<body class="k2b-ui" style="margin:0;padding:12px"><div style="width:${frame}px">${html}</div></body></html>`,
      );
      await settled(page);
      const cut = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".k2b-stat-cell .k2b-flow-amount")).flatMap((amount) => {
          const tile = amount.closest(".k2b-stat-cell")!.getBoundingClientRect();
          const box = amount.getBoundingClientRect();
          return box.left >= tile.left && box.right <= tile.right + 0.5 && amount.scrollWidth <= amount.clientWidth + 1
            ? []
            : [`${amount.textContent} (${Math.round(box.width)} in ${Math.round(tile.width)})`];
        }),
      );
      expect({ width, frame, cut }).toEqual({ width, frame, cut: [] });
    } finally {
      await page.close();
    }
  }
});
