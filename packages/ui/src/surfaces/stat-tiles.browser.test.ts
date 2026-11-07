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
  for (const [name, width, columns, height, valueSize] of [
    ["desktop", 1440, 4, 136, 28],
    // Narrow tiles give the comparison its own line (showcase review 07.11.), so the dashboard tile is 172 px there.
    ["600 px grid", 620, 2, 172, 28],
    ["phone", 390, 2, 172, 23.04],
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
        // In a grid of 600 px or less the taller tile puts the badge under the figure; a phone tile also shrinks it.
        expect(data.badgeBelow).toBe(name !== "desktop");
        // Engines round container units differently (WebKit: 23.040001px), so compare the number.
        expect(Number.parseFloat(data.valueSize)).toBeCloseTo(valueSize, 1);
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
    // 300 px leaves a 276 px grid: one tile per row.
    for (const width of [1440, 800, 390, 300]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" style="margin:0;padding:12px">${grids}</body></html>`,
        );
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

  test("a narrow md or sm tile keeps its height in every state, with the badge under the figure", async () => {
    const rows = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return (["md", "sm"] as const).flatMap((size) =>
            Object.values(states).map((props) =>
              createComponent(StatGrid, {
                size,
                columns: 4,
                class: `size-${size}`,
                get children() {
                  return ["A", "B"].map((label) => createComponent(StatCell, { label, ...props } as never));
                },
              }),
            ),
          );
        },
      }),
    );
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    try {
      await page.setContent(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
          `<body class="k2b-ui" style="margin:0;padding:12px"><div style="width:300px">${rows}</div></body></html>`,
      );
      await settled(page);
      const heights = await page.evaluate(() =>
        ["md", "sm"].map((size) => [
          ...new Set(
            Array.from(document.querySelectorAll(`.size-${size} .k2b-stat-cell`)).map((tile) =>
              Math.round(tile.getBoundingClientRect().height),
            ),
          ),
        ]),
      );
      expect(heights.map((list) => list.length)).toEqual([1, 1]);
    } finally {
      await page.close();
    }
  });

  // Regression: at 390 px a dashboard's md tiles ended their figures in "48…" (07.11.). A figure is never cut.
  test("a figure always fits its tile, in every size, down to a 320 px phone", async () => {
    const values = ["48.210", "1.204,80 €", "€2,380.00", "29.260 €", "Action needed", "1,2 Mio. €"];
    const grids = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return (["lg", "md", "sm"] as const).map((size) =>
            createComponent(StatGrid, {
              size,
              columns: 4,
              get children() {
                return values.map((value, index) =>
                  createComponent(StatCell, {
                    label: `Figure ${index + 1}`,
                    icon: "ti ti-users",
                    value,
                    delta: { value: -0.125, better: "down" },
                    compare: { label: "Vormonat", value: 44560 },
                  }),
                );
              },
            }),
          );
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
            `<body class="k2b-ui" style="margin:0;padding:12px"><div style="width:${frame}px;display:grid;gap:16px">${grids}</div></body></html>`,
        );
        await settled(page);
        const cut = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>(".k2b-stat-cell__value")).flatMap((value) => {
            const tile = value.closest(".k2b-stat-cell")!.getBoundingClientRect();
            const box = value.getBoundingClientRect();
            const style = getComputedStyle(value);
            const badge = value.parentElement!.querySelector(".k2b-stat-cell__delta")?.getBoundingClientRect();
            const inside = (rect: DOMRect) =>
              rect.left >= tile.left && rect.right <= tile.right + 0.5 && rect.top >= tile.top && rect.bottom <= tile.bottom + 0.5;
            const fits = value.scrollWidth <= value.clientWidth + 1 && inside(box) && (!badge || inside(badge));
            return fits && style.textOverflow !== "ellipsis"
              ? []
              : [`${value.textContent} (${Math.round(box.width)} in ${Math.round(tile.width)})`];
          }),
        );
        expect({ width, frame, cut }).toEqual({ width, frame, cut: [] });
      } finally {
        await page.close();
      }
    }
  });

  // Regression (showcase review 07.11.): a tile without a change badge set its figure lower than its neighbours, and a
  // compare line beside a sparkline ended in "Last month …" at 390 px.
  test("figures in a row share one line and the comparison is never cut, with or without badge and trend", async () => {
    const trend = [38900, 40500, 42200, 43300, 44000, 44560, 48210];
    const row = (size: "lg" | "md" | "sm") =>
      createComponent(StatGrid, {
        size,
        columns: 4,
        class: `align-${size}`,
        get children() {
          return [
            createComponent(StatCell, {
              label: "Balance today",
              icon: "ti ti-building-bank",
              value: "€21,140",
              delta: { value: -0.047, better: "up" },
              compare: { label: "30 days ago", value: "€22,180" },
            }),
            createComponent(StatCell, {
              label: "Lowest in 60 days",
              icon: "ti ti-alert-triangle",
              value: "€6,650",
              sub: "Expected on 1 Dec · threshold €10,000",
            }),
            createComponent(StatCell, {
              label: "Subscribers",
              icon: "ti ti-users",
              value: "48,210",
              delta: { value: 0.082, better: "up" },
              compare: { label: "Last month", value: 44560 },
              trend,
            }),
            createComponent(StatCell, {
              label: "Unsubscribes",
              icon: "ti ti-user-minus",
              value: "182",
              compare: { label: "Last month", value: 208 },
            }),
          ];
        },
      });
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "en",
        get children() {
          return (["lg", "md", "sm"] as const).map(row);
        },
      }),
    );
    for (const [width, frame] of [
      [390, 366],
      [1440, 1384],
    ] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.setContent(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
            `<body class="k2b-ui" style="margin:0;padding:12px"><div style="width:${frame}px;display:grid;gap:16px">${html}</div></body></html>`,
        );
        await settled(page);
        const result = await page.evaluate(() =>
          ["lg", "md", "sm"].map((size) => {
            const tiles = Array.from(document.querySelectorAll<HTMLElement>(`.align-${size} .k2b-stat-cell`));
            // Tiles on the same grid row (same top) must put their figures on the same line.
            const rows = new Map<number, number[]>();
            for (const tile of tiles) {
              const top = Math.round(tile.getBoundingClientRect().top);
              const value = tile.querySelector(".k2b-stat-cell__value")!.getBoundingClientRect().top;
              rows.set(top, [...(rows.get(top) ?? []), value]);
            }
            const spread = Math.max(...[...rows.values()].map((tops) => Math.max(...tops) - Math.min(...tops)));
            const cut = Array.from(document.querySelectorAll<HTMLElement>(`.align-${size} .k2b-stat-cell__sub`)).flatMap((sub) => {
              const tile = sub.closest(".k2b-stat-cell")!.getBoundingClientRect();
              const box = sub.getBoundingClientRect();
              const whole =
                sub.scrollWidth <= sub.clientWidth + 1 &&
                box.left >= tile.left &&
                box.right <= tile.right + 0.5 &&
                box.bottom <= tile.bottom + 0.5;
              return whole && getComputedStyle(sub).textOverflow !== "ellipsis" ? [] : [sub.textContent];
            });
            return { size, spread: Math.round(spread * 10) / 10, cut };
          }),
        );
        expect({ width, result }).toEqual({
          width,
          result: [
            { size: "lg", spread: 0, cut: [] },
            { size: "md", spread: 0, cut: [] },
            { size: "sm", spread: 0, cut: [] },
          ],
        });
      } finally {
        await page.close();
      }
    }
  });
});
