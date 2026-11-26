import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { transparentIslands } from "../../scripts/v2-island-css";
import { launchBrowser, settled } from "../../test/browser";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { describeV2Page, measureV2Layout } from "./testing";

// A small island can stand wherever a v2 primitive stands. @k2b/ssr renders every island in a `<solid-island>` (a
// client in a `<solid-client>`) of `display: contents`; the shipped v2.css looks through it. Each recipe of the k2b-ui
// skill renders once without islands and once with its controls, and once with its blocks, each in an island of its
// own: every box, every drawn line and the outline stay the same.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-islands-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const recipesDir = resolve(import.meta.dir, "../../skills/k2b-ui/recipes");
const recipes = readdirSync(recipesDir)
  .filter((name) => name.endsWith(".tsx"))
  .sort();
const markup = new Map<string, string>();
for (const name of recipes) {
  const screen = (await import(resolve(recipesDir, name))) as { default: Parameters<typeof createComponent>[0] };
  markup.set(
    name,
    renderToString(() => createComponent(screen.default, {})),
  );
}
const source = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const shipped = transparentIslands(source);
// The style `html()` of @k2b/ssr writes into every page.
const islandStyle = "solid-client,solid-island{display:contents}";
const testCss =
  "html, body { margin: 0; height: 100%; } .frame { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

const controls = [
  "Button",
  "Input",
  "Select",
  "DateInput",
  "Check",
  "Choice",
  "Tabs",
  "FilterBar",
  "Field",
  "Chip",
  "Avatar",
  "Text",
  "Inline",
  "Path",
  "Steps",
  "Progress",
];
const blocks = [
  "Bar",
  "StatusRow",
  "Section",
  "Group",
  "List",
  "Row",
  "Table",
  "Facts",
  "Notice",
  "Band",
  "Prose",
  "Cells",
  "Tiles",
  "Nav",
];
const modes = {
  controls: controls.map((name) => `[data-k2-part="${name}"]`).join(", "),
  blocks: blocks.map((name) => `[data-k2-part="${name}"]`).join(", "),
  // A row that is one island in its list (an HTML parser moves an element out of a table, so no table row).
  rows: '[data-k2-part="Row"], [data-k2-part="Digest.Entry"], [data-k2-part="Field"], [data-k2-part="Cells.Cell"]',
};

const page = async (css: string, html: string, width: number, wrap?: string) => {
  const opened = await browser.newPage({ viewport: { width, height: 900 } });
  await opened.setContent(
    `<!doctype html><html lang="de"><head><style>${islandStyle}</style><style>${css}</style><style>${testCss}</style></head>` +
      `<body class="k2-ui"><div class="frame">${html}</div></body></html>`,
  );
  if (wrap)
    await opened.evaluate((selector) => {
      // Each outermost match gets an island of its own, as an application would write it.
      const picked = [...document.querySelectorAll(selector)].filter((element) => !element.parentElement?.closest(selector));
      picked.forEach((element, index) => {
        const island = document.createElement(index % 2 ? "solid-client" : "solid-island");
        island.dataset.id = `island-${index}`;
        element.replaceWith(island);
        island.append(element);
      });
    }, wrap);
  await settled(opened);
  return opened;
};

/** Every box and every line a person sees: the boxes of all elements but the wrappers, with their drawn style. */
const snapshot = (opened: Page) =>
  opened.evaluate(() => {
    const properties = [
      "display",
      "position",
      "margin-top",
      "margin-right",
      "margin-bottom",
      "margin-left",
      "padding-top",
      "padding-right",
      "padding-bottom",
      "padding-left",
      "border-top",
      "border-right",
      "border-bottom",
      "border-left",
      "border-radius",
      "box-shadow",
      "outline",
      "background-color",
      "color",
      "font-size",
      "font-weight",
      "line-height",
      "opacity",
      "visibility",
      "overflow",
      "white-space",
      "text-overflow",
      "gap",
      "flex",
      "order",
      "z-index",
    ];
    const pseudo = ["content", "display", "position", "width", "height", "border-top", "border-bottom", "background-color", "box-shadow"];
    const rows: string[] = [];
    for (const element of document.querySelectorAll(".frame *")) {
      if (/^solid-(?:island|client)$/.test(element.localName)) continue;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const before = getComputedStyle(element, "::before");
      const after = getComputedStyle(element, "::after");
      const name = `${element.localName}${element.className && typeof element.className === "string" ? `.${element.className.trim().split(/\s+/).join(".")}` : ""}`;
      // A part out of sight at this width (the other form of a table, a phone-only bar) draws nothing; WebKit also
      // computes its display differently below a wrapper (`flex` against `inline-flex`), which no one sees.
      if (!element.getClientRects().length) {
        rows.push(`${name} hidden`);
        continue;
      }
      rows.push(
        [
          name,
          [box.x, box.y, box.width, box.height].map((value) => value.toFixed(2)).join(","),
          properties.map((property) => style.getPropertyValue(property)).join("|"),
          before.content === "none" ? "" : pseudo.map((property) => before.getPropertyValue(property)).join("|"),
          after.content === "none" ? "" : pseudo.map((property) => after.getPropertyValue(property)).join("|"),
        ].join(" "),
      );
    }
    return rows;
  });

/** The first rows that differ, so a failure names the element and what changed. */
const differences = (expected: string[], actual: string[]) => {
  const found: string[] = [];
  if (expected.length !== actual.length) found.push(`${expected.length} elements, then ${actual.length}`);
  for (let index = 0; index < Math.min(expected.length, actual.length) && found.length < 6; index++)
    if (expected[index] !== actual[index]) found.push(`- ${expected[index]}\n+ ${actual[index]}`);
  return found;
};

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

describe("a small island inside a v2 container keeps the container's layout", () => {
  test("there are recipes", () => {
    expect(recipes.length).toBeGreaterThanOrEqual(6);
  });
  for (const name of recipes)
    for (const width of [1440, 390])
      test(`${name} at ${width} px`, async () => {
        const html = markup.get(name)!;
        const plain = await page(source, html, width);
        const opened: Page[] = [plain];
        try {
          const expected = await snapshot(plain);
          const outline = await describeV2Page(plain, ".frame");
          // Without an island, the shipped sheet draws exactly what the source draws.
          const same = await page(shipped, html, width);
          opened.push(same);
          expect(differences(expected, await snapshot(same))).toEqual([]);
          let placed = 0;
          for (const [mode, selector] of Object.entries(modes)) {
            const wrapped = await page(shipped, html, width, selector);
            opened.push(wrapped);
            // A recipe without rows has nothing to wrap in that mode.
            const islands = await wrapped.locator("solid-island, solid-client").count();
            placed += islands;
            if (!islands) continue;
            expect(differences(expected, await snapshot(wrapped)), mode).toEqual([]);
            expect(await describeV2Page(wrapped, ".frame"), mode).toBe(outline);
            expect((await measureV2Layout(wrapped, { root: "[data-k2-workspace]" })).problems, mode).toEqual([]);
          }
          expect(placed, "islands placed").toBeGreaterThan(2);
        } finally {
          await Promise.all(opened.map((each) => each.close()));
        }
      }, 60_000);
});
