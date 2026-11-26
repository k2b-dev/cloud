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

const open = async (scope: { theme?: "dark"; app?: string; forced?: boolean } = {}): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
        resolved(page, `color-mix(in srgb, ${colour} ${theme === "dark" ? "28%" : "8%"}, var(--k2-surface))`);
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
      // a row chosen for a deed takes the owner's tint too, never a generic blue
      expect(await background('table[aria-label="Belege"] tr[data-selected] > td')).toBe(await tint("#7c3aed"));
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
