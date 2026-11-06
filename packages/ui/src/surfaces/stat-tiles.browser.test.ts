import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";

// Tile heights, grid columns and where the change badge sits are layout, which only a real engine renders.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-stat-tiles-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { StatCell } = await import("./StatCell");
const { StatGrid } = await import("./StatGrid");
const { LocaleProvider } = await import("../intl/locale");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const trend = [38900, 39800, 40500, 41400, 42200, 42800, 43300, 43700, 44000, 44300, 44560, 48210];
const states: Record<string, Record<string, unknown>> = {
  data: { value: "48.210", delta: { value: 0.082, better: "up" }, compare: { label: "Vormonat", value: 44560 }, trend },
  loading: { value: "48.210", status: "loading" },
  error: { value: "48.210", status: "error", onRetry: () => undefined },
  empty: { value: null, sub: "Im Zeitraum nichts gezählt" },
  stale: { value: "48.210", delta: { value: 0.082, better: "up" }, stale: "Stand 09:12 · nicht aktuell", onRetry: () => undefined },
};

/** One row per state, four tiles each, so every state is measured beside its neighbours. */
const markup = () =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return Object.entries(states).map(([state, props]) =>
          createComponent(StatGrid, {
            size: "lg",
            columns: 4,
            class: `state-${state}`,
            get children() {
              return ["Abonnenten", "Öffnungsrate", "Klickrate", "Abmeldungen"].map((label) =>
                createComponent(StatCell, { label, icon: "ti ti-users", tone: "blue", ...props } as never),
              );
            },
          }),
        );
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
  Array.from(document.querySelectorAll<HTMLElement>(".k2b-stat-grid")).map((grid) => {
    const tiles = Array.from(grid.querySelectorAll<HTMLElement>(".k2b-stat-cell"));
    const first = tiles[0]!;
    const box = (selector: string) => first.querySelector(selector)?.getBoundingClientRect();
    const value = box(".k2b-stat-cell__value");
    const badge = box(".k2b-stat-cell__delta");
    return {
      state: grid.className.replace(/.*state-/, "").trim(),
      columns: new Set(tiles.map((tile) => Math.round(tile.getBoundingClientRect().left))).size,
      heights: [...new Set(tiles.map((tile) => Math.round(tile.getBoundingClientRect().height)))],
      head: Math.round(box(".k2b-stat-cell__head")!.top - first.getBoundingClientRect().top),
      main: Math.round(box(".k2b-stat-cell__main")!.top - first.getBoundingClientRect().top),
      support: Math.round(box(".k2b-stat-cell__support")!.top - first.getBoundingClientRect().top),
      badgeBelow: value && badge ? badge.top >= value.bottom - 1 : null,
      valueSize: getComputedStyle(first.querySelector(".k2b-stat-cell__value") ?? first).fontSize,
    };
  });

describe("@k2b/ui key figure tiles", () => {
  for (const [name, width, columns, height] of [
    ["desktop", 1440, 4, 136],
    ["phone", 390, 2, 164],
  ] as const) {
    test(`on a ${name} every state keeps the tile's size and rows (${columns} columns, ${height}px)`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.setContent(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
            `<body class="k2b-ui" style="margin:0;padding:12px">${markup()}</body></html>`,
        );
        await settled(page);
        const rows = await page.evaluate(measure);
        expect(rows.map((row) => row.state)).toEqual(Object.keys(states));
        for (const row of rows) {
          expect({ state: row.state, columns: row.columns, heights: row.heights }).toEqual({
            state: row.state,
            columns,
            heights: [height],
          });
        }
        // The head, figure and support rows start at the same place in every state: nothing jumps when data arrives.
        for (const part of ["head", "main", "support"] as const) expect(new Set(rows.map((row) => row[part])).size).toBe(1);
        const data = rows.find((row) => row.state === "data")!;
        // A phone tile is too narrow for figure and badge side by side, so the badge moves under the figure.
        expect(data.badgeBelow).toBe(name === "phone");
        expect(data.valueSize).toBe(name === "phone" ? "22px" : "28px");
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      } finally {
        await page.close();
      }
    });
  }

  test("a row that breaks leaves no empty slot: the last tile reaches the grid's end", async () => {
    const grids = renderToString(() =>
      [3, 5, 6].map((count) =>
        createComponent(StatGrid, {
          columns: count as 3 | 5 | 6,
          get children() {
            return Array.from({ length: count }, (_, index) => createComponent(StatCell, { label: `Figure ${index + 1}`, value: index }));
          },
        }),
      ),
    );
    for (const width of [1440, 800, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" style="margin:0;padding:12px">${grids}</body></html>`);
        await settled(page);
        const gaps = await page.evaluate(() =>
          Array.from(document.querySelectorAll(".k2b-stat-grid__body")).map((body) =>
            Math.round(Math.abs(body.lastElementChild!.getBoundingClientRect().right - body.getBoundingClientRect().right)),
          ),
        );
        expect({ width, gaps }).toEqual({ width, gaps: [0, 0, 0] });
      } finally {
        await page.close();
      }
    }
  });
});
