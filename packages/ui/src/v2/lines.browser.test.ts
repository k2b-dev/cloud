import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, launchHookMs, settled } from "../../test/browser";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { measureV2Layout } from "./testing";

// Line weights and the colour of the open row (identity B): a very quiet line between rows, the clear line only where
// two things are separated (a head and its content, a list and its detail, one section and the next); the open or
// selected row in a soft tint of the app the rows belong to, the app of the page by default.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-lines-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { LinesFixture } = await import("../../test/v2-lines.fixture");
const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const markup = renderToString(() => createComponent(LinesFixture, {}));

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const open = async (scope: { theme?: "dark"; app?: string; forced?: boolean; width?: number } = {}): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: scope.width ?? 1440, height: 900 } });
  if (scope.forced) await page.emulateMedia({ forcedColors: "active" });
  const style = scope.app ? ` style="--k2-app: ${scope.app}"` : "";
  const theme = scope.theme ? ` data-theme="${scope.theme}"` : "";
  await page.setContent(
    `<!doctype html><html lang="de"><head><style>${css}</style><style>html, body { margin: 0; height: 100%; } .frame { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }</style></head>` +
      `<body class="k2-ui"${theme}${style}><div class="frame">${markup}</div></body></html>`,
  );
  await settled(page);
  return page;
};

/** The computed colour of a CSS colour value, as the page resolves it in the scope (theme, app colour). */
const resolved = (page: Page, value: string) =>
  page.evaluate((colour) => {
    const probe = document.createElement("i");
    probe.style.color = colour;
    document.body.append(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, value);

/** The bottom line of each place: width and colour. */
const lines = (page: Page) =>
  page.evaluate(() => {
    const line = (selector: string, side: "bottom" | "left" = "bottom") => {
      const element = document.querySelector(selector);
      if (!element) return "missing";
      const style = getComputedStyle(element);
      return side === "bottom"
        ? `${style.borderBottomWidth} ${style.borderBottomColor}`
        : `${style.borderLeftWidth} ${style.borderLeftColor}`;
    };
    const seam = document.querySelector(".k2-split > .k2-seam");
    return {
      row: line(".k2-list > .k2-row"),
      cell: line('table[aria-label="Positionen"] tbody tr:not([aria-current]) > td'),
      columnHead: line('table[aria-label="Positionen"] thead th'),
      head: line(".k2-pane[data-detail] .k2-bar"),
      section: line(".k2-sec"),
      seam: seam ? `${getComputedStyle(seam).width} ${getComputedStyle(seam).backgroundColor}` : "missing",
    };
  });

test("lines: rows and cells part with the quiet line, heads, seams and sections with the clear one, in light and dark", async () => {
  for (const theme of [undefined, "dark"] as const) {
    const page = await open({ theme, app: "#0f766e" });
    try {
      const quiet = `1px ${await resolved(page, "var(--k2-line-subtle)")}`;
      const clear = `1px ${await resolved(page, "var(--k2-line)")}`;
      expect(quiet).not.toBe(clear);
      expect(await lines(page)).toEqual({ row: quiet, cell: quiet, columnHead: clear, head: clear, section: clear, seam: clear });
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
    } finally {
      await page.close();
    }
  }
});

test("the open row is tinted in the colour of the app its rows belong to: the page's app by default, a table's own `color`", async () => {
  for (const theme of [undefined, "dark"] as const) {
    const page = await open({ theme, app: "#0f766e" });
    try {
      const tint = (colour: string) =>
        resolved(page, `color-mix(in srgb, ${colour} ${theme === "dark" ? "18%" : "7%"}, var(--k2-surface))`);
      const background = (selector: string) =>
        page.evaluate((target) => {
          const element = document.querySelector(target);
          return element ? getComputedStyle(element).backgroundColor : "missing";
        }, selector);
      // the page's app (teal) for the list and the table of the page
      expect(await background(".k2-list > .k2-row[data-current]")).toBe(await tint("#0f766e"));
      expect(await background('table[aria-label="Positionen"] tr[aria-current] > td')).toBe(await tint("#0f766e"));
      // a table of another app (violet) takes that app's colour, not the page's and not blue
      expect(await background('table[aria-label="Belege"] tr[aria-current] > td')).toBe(await tint("#7c3aed"));
      // a row chosen in a selection keeps the blue of a selection, apart from the open row (Mail's "2 ausgewählt")
      expect(await background('table[aria-label="Belege"] tr[data-selected] > td')).toBe(await resolved(page, "var(--k2-blue-tint)"));
      // the quiet line under a tinted row leaves, as in study B: the tint parts it; the line keeps its pixel, so nothing moves
      const under = (selector: string) =>
        page.evaluate((target) => {
          const element = document.querySelector(target);
          if (!element) return "missing";
          const style = getComputedStyle(element);
          return `${style.borderBottomWidth} ${style.borderBottomColor}`;
        }, selector);
      for (const selector of [
        ".k2-list > .k2-row[data-current]",
        'table[aria-label="Positionen"] tr[aria-current] > td',
        'table[aria-label="Belege"] tr[data-selected] > td',
      ])
        expect([selector, await under(selector)]).toEqual([selector, "1px rgba(0, 0, 0, 0)"]);
      // a row that is not open keeps its quiet line
      expect(await under(".k2-list > .k2-row:not([data-current])")).toBe(`1px ${await resolved(page, "var(--k2-line-subtle)")}`);
    } finally {
      await page.close();
    }
  }
  // without an app colour the open row keeps the blue tint of v2
  const page = await open();
  try {
    expect(
      await page.evaluate(
        () => getComputedStyle(document.querySelector('table[aria-label="Positionen"] tr[aria-current] > td')!).backgroundColor,
      ),
    ).toBe(await resolved(page, "var(--k2-blue-tint)"));
  } finally {
    await page.close();
  }
});

test("at 390 px the phone form of another app's table keeps that app's tint for its open row, a chosen row the blue", async () => {
  for (const theme of [undefined, "dark"] as const) {
    const page = await open({ theme, app: "#0f766e", width: 390 });
    try {
      const tint = await resolved(page, `color-mix(in srgb, #7c3aed ${theme === "dark" ? "18%" : "7%"}, var(--k2-surface))`);
      const blue = await resolved(page, "var(--k2-blue-tint)");
      const found = await page.evaluate(() => {
        const phone = [...document.querySelectorAll(".k2-table-phone")].find((each) => getComputedStyle(each).display !== "none");
        const background = (selector: string) => {
          const element = phone?.querySelector(selector);
          return element ? getComputedStyle(element).backgroundColor : "missing";
        };
        return { open: background(".k2-row[data-current]"), chosen: background(".k2-row[data-selected]") };
      });
      expect(found).toEqual({ open: tint, chosen: blue });
    } finally {
      await page.close();
    }
  }
});

// One test per theme and app colour, one page each, so each stays far inside its time in WebKit.
const appColours = { teal: "#14b8a6", blue: "#3b82f6", violet: "#8b5cf6", yellow: "#eab308", green: "#22c55e" };
for (const theme of [undefined, "dark"] as const)
  for (const [name, app] of Object.entries(appColours))
    test(`the quiet text of an open or chosen row keeps 4.5:1 on the tint of the app colour ${name}, ${theme ?? "light"}`, async () => {
      const page = await open({ theme, app });
      try {
        const found = await page.evaluate(() => {
          const channels = (colour: string) => {
            const srgb = colour.match(/color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)/);
            if (srgb) return srgb.slice(1, 4).map(Number);
            const rgb = colour.match(/rgba?\((\d+), (\d+), (\d+)/);
            return rgb ? rgb.slice(1, 4).map((value) => Number(value) / 255) : [Number.NaN, Number.NaN, Number.NaN];
          };
          const luminance = (colour: string) => {
            const [r, g, b] = channels(colour).map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
            return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
          };
          const ratio = (selector: string) => {
            const element = document.querySelector(selector);
            if (!element) return "missing";
            const probe = document.createElement("span");
            probe.style.color = "var(--k2-subtle)";
            element.append(probe);
            const [light, dark] = [luminance(getComputedStyle(probe).color), luminance(getComputedStyle(element).backgroundColor)].sort(
              (a, b) => b - a,
            );
            probe.remove();
            return Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100;
          };
          return {
            row: ratio(".k2-list > .k2-row[data-current]"),
            cell: ratio('table[aria-label="Positionen"] tr[aria-current] > td'),
            chosen: ratio('table[aria-label="Belege"] tr[data-selected] > td'),
          };
        });
        for (const [place, value] of Object.entries(found))
          expect([place, typeof value === "number" && value >= 4.5]).toEqual([place, true]);
      } finally {
        await page.close();
      }
    });

test("a list ends without a line; only a grid table keeps its clear end line", async () => {
  const page = await open({ app: "#0f766e" });
  try {
    const clear = `1px ${await resolved(page, "var(--k2-line)")}`;
    const found = await page.evaluate(() => {
      const under = (selector: string) => {
        const element = document.querySelector(selector);
        return element ? getComputedStyle(element).borderBottomWidth : "missing";
      };
      const end = getComputedStyle(document.querySelector('table[aria-label="Belege"] tbody tr:last-child > td')!);
      return {
        list: under(".k2-list > .k2-row:last-child"),
        table: under('table[aria-label="Positionen"] tbody tr:last-child > td'),
        grid: `${end.borderBottomWidth} ${end.borderBottomColor}`,
      };
    });
    expect(found).toEqual({ list: "0px", table: "0px", grid: clear });
  } finally {
    await page.close();
  }
});

test("forced colours: the quiet lines stay drawn, and the open row stands out in a frame of the system's highlight", async () => {
  const page = await open({ forced: true, app: "#0f766e" });
  try {
    const found = await page.evaluate(() => {
      const row = getComputedStyle(document.querySelector(".k2-list > .k2-row")!);
      const frame = (selector: string) => {
        const style = getComputedStyle(document.querySelector(selector)!);
        return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`;
      };
      const probe = document.createElement("i");
      probe.style.color = "Highlight";
      document.body.append(probe);
      const highlight = getComputedStyle(probe).color;
      probe.remove();
      return {
        width: row.borderBottomWidth,
        style: row.borderBottomStyle,
        list: frame(".k2-list > .k2-row[data-current]"),
        table: frame('table[aria-label="Positionen"] tr[aria-current]'),
        highlight,
      };
    });
    expect({ width: found.width, style: found.style }).toEqual({ width: "1px", style: "solid" });
    expect([found.list, found.table]).toEqual([`solid 2px ${found.highlight}`, `solid 2px ${found.highlight}`]);
  } finally {
    await page.close();
  }
});
