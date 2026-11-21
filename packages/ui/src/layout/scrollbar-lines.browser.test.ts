import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";
import { layoutProblems } from "../../test/head-overlap";

// "A scrollbar moves nothing" (Valentin 21.11.: "dass durch eine Scrollbar plötzlich Platz eingenommen wird und dann
// Linien nicht mehr verbunden sind in einer Tabelle"). The page forces classic 15 px scrollbars, also where DataTable
// would draw its overlay thumb, and every case runs with a few rows (no scrollbar) and many rows (a scrollbar).
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const classic = `
  .k2b-ui .scroll, .k2b-ui .green { scrollbar-width: auto !important; }
  .k2b-ui .scroll::-webkit-scrollbar, .k2b-ui .green::-webkit-scrollbar { width: 15px !important; height: 15px !important; }
  .k2b-ui .scroll::-webkit-scrollbar-thumb, .k2b-ui .green::-webkit-scrollbar-thumb { background: #a1a1aa; }
  .frame { width: 600px; height: 200px; display: flex; margin-bottom: 16px; }
  .split { width: 600px; margin-bottom: 16px; }
  .split table, .green table { width: 100%; table-layout: fixed; border-collapse: collapse; }
  .split td, .split th, .green td, .green th { height: 32px; padding: 0 8px; text-align: left; }
  .scroll { height: 160px; overflow: auto; }
  .green { width: 600px; height: 200px; overflow: auto; scrollbar-gutter: stable; }
  .green thead { position: sticky; top: 0; background: #fff; }
`;
const entry = resolve(import.meta.dir, "scrollbar-lines.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { DataTable } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const columns = [
  { id: "name", header: "Item", value: "name", primary: true },
  { id: "place", header: "Place", value: "place" },
  { id: "amount", header: "Estimate", value: "amount", type: "amount", format: { currency: "EUR" } },
];
const rows = (count) => Array.from({ length: count }, (_, i) => ({ name: "Item " + (i + 1), place: "Shelf " + (i % 9), amount: 100 + i }));
for (const [id, count] of [["few", 2], ["many", 40]])
  render(() => createComponent(DataTable, { columns, rows: rows(count), class: "frame", surface: "plain", ariaLabel: id }), document.getElementById(id));
const cells = (n) => Array.from({ length: n }, (_, i) => "<td>Cell " + (i + 1) + "</td>").join("");
const body = (count) => Array.from({ length: count }, () => "<tr>" + cells(3) + "</tr>").join("");
const head = "<thead><tr><th>Item</th><th>Place</th><th>Estimate</th></tr></thead>";
// Red: head and body in two containers; only the body scrolls, so its scrollbar narrows the body columns.
for (const [id, count] of [["red-few", 2], ["red-many", 40]])
  document.getElementById(id).innerHTML = '<div class="split"><table>' + head + '</table><div class="scroll"><table><tbody>' + body(count) + "</tbody></table></div></div>";
// Green: a sticky head in the same scroll area that keeps its gutter.
for (const [id, count] of [["green-few", 2], ["green-many", 40]])
  document.getElementById(id).innerHTML = '<div class="green"><table>' + head + "<tbody>" + body(count) + "</tbody></table></div>";
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the scrollbar lines fixture");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  // Headless Chromium hides scrollbars by default, so they take no room; this file needs the classic ones a desktop draws.
  browser = await launchBrowser({ ignoreDefaultArgs: ["--hide-scrollbars"] });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style><style>${classic}</style></head><body class="k2b-ui" style="margin:0;padding:16px">` +
      ["few", "many", "red-few", "red-many", "green-few", "green-many"].map((id) => `<div id="${id}"></div>`).join("") +
      "</body></html>",
  );
  await page.addScriptTag({ content: script });
  await page.locator("#many tbody tr").first().waitFor();
  await settled(page);
  return page;
};

/** The x edges of a root's head cells, relative to the root. */
const headEdges = (page: Page, root: string) =>
  page.evaluate((root) => {
    const base = document.querySelector(root)!.getBoundingClientRect().left;
    return Array.from(document.querySelectorAll(`${root} thead th`)).map((cell) => {
      const box = cell.getBoundingClientRect();
      return [Math.round((box.left - base) * 10) / 10, Math.round((box.right - base) * 10) / 10];
    });
  }, root);

/**
 * Whether a root's scroll area shows a classic scrollbar, so the "many" cases really test one. Chromium draws them
 * here; an engine that only overlays its scrollbars (WebKit on Linux in CI) has no room to lose, so its cases only
 * check that nothing is reported.
 */
const classicScrollbars = browserName === "chromium";
const scrolls = (page: Page, selector: string) =>
  page
    .locator(selector)
    .evaluate((area: HTMLElement) => area.scrollHeight > area.clientHeight && area.offsetWidth - area.clientWidth >= 15);

describe("a scrollbar moves nothing", () => {
  test("red template: a head and a body in two containers break their lines when the body scrolls", async () => {
    const page = await load();
    try {
      expect((await page.evaluate(layoutProblems, { root: "#red-few" })).scrollbar).toEqual([]);
      if (!classicScrollbars) return;
      expect(await scrolls(page, "#red-many .scroll")).toBe(true);
      const found = (await page.evaluate(layoutProblems, { root: "#red-many" })).scrollbar;
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((line) => line.startsWith("line break by scrollbar"))).toBe(true);
    } finally {
      await page.close();
    }
  });

  test("green template: a sticky head in the same scroll area with a stable gutter keeps its lines", async () => {
    const page = await load();
    try {
      for (const root of ["#green-few", "#green-many"]) expect((await page.evaluate(layoutProblems, { root })).scrollbar).toEqual([]);
      // WebKit on Linux draws classic scrollbars but keeps no gutter for them; the stable gutter is Chromium's here.
      if (!classicScrollbars) return;
      expect(await scrolls(page, "#green-many .green")).toBe(true);
      // Nothing moves when the scrollbar appears: the head cells stand where they stood without it.
      expect(await headEdges(page, "#green-many")).toEqual(await headEdges(page, "#green-few"));
    } finally {
      await page.close();
    }
  });

  test("DataTable keeps its head over its rows and every head cell in place when its rows start to scroll", async () => {
    const page = await load();
    try {
      // With a fine pointer the table draws its own overlay thumb: the rows overflow, and no native scrollbar takes room.
      expect(await page.locator("#many .k2b-table-shell").getAttribute("data-overflow-y")).toBe("true");
      for (const root of ["#few", "#many"]) {
        const found = await page.evaluate(layoutProblems, { root });
        expect({ root, scrollbar: found.scrollbar }).toEqual({ root, scrollbar: [] });
      }
      expect(await headEdges(page, "#many")).toEqual(await headEdges(page, "#few"));
    } finally {
      await page.close();
    }
  });
});
