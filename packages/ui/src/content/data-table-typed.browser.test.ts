import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "data-table-typed.fixture.ts");
// Invented campaigns in a frame whose head holds the tools; the host width comes from the page.
const fixture = `
import { createComponent, render } from "solid-js/web";
import { createDataTableView, DataTable, DataTableTools } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const states = { sending: { label: "Sending", tone: "running" }, delivered: { label: "Delivered", tone: "ok" }, scheduled: { label: "Scheduled", tone: "neutral" } };
const columns = [
  { id: "name", header: "Campaign", value: "name", type: "text", sortable: true },
  { id: "status", header: "Status", value: "status", type: "status", states, sortable: true },
  { id: "date", header: "Sent", value: "date", type: "date", priority: 3, sortable: true },
  { id: "to", header: "Recipients", value: "to", type: "number", priority: 3, sortable: true },
  { id: "open", header: "Opened", value: "open", type: "bar", format: { style: "percent" }, max: 0.6, sortable: true },
  { id: "rev", header: "Revenue", value: "rev", type: "amount", format: { currency: "EUR" }, priority: 2, sortable: true },
];
const rows = [
  { name: "Autumn selection", status: "sending", date: "2026-11-06", to: 46900, open: 0.314, rev: 2140 },
  { name: "Weekly letter 44", status: "delivered", date: "2026-10-29", to: 46720, open: 0.492, rev: 4610 },
  { name: "Trade fair invitation", status: "scheduled", date: "2026-11-12", to: 47000, open: null, rev: null },
  { name: "New in stock", status: "delivered", date: "2026-10-22", to: 46510, open: 0.526, rev: 6380 },
];
render(() => {
  const view = createDataTableView({ rows: () => rows, columns: () => columns });
  return [
    createComponent(DataTableTools, {
      label: "Campaigns",
      get query() { return view.query(); },
      onQueryChange: view.setQuery,
      groups: [{ id: "status", label: "Status" }],
      get groupBy() { return view.groupBy(); },
      onGroupByChange: view.setGroupBy,
    }),
    createComponent(DataTable, {
      ariaLabel: "Campaigns", surface: "plain", columns,
      get rows() { return view.rows(); },
      get sort() { return view.sort(); },
      onSortChange: view.setSort,
      get groupBy() { return view.groupBy() ?? undefined; },
      get query() { return view.query(); },
      onClearQuery: () => { view.setQuery(""); document.querySelector(".k2b-data-table-tools input").focus(); },
    }),
  ];
}, document.getElementById("host"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the typed table fixture");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const mount = async (page: Page, width: number) => {
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="host" style="width:${width}px"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await settled(page);
};
const visibleHeaders = (page: Page) =>
  page
    .locator("thead th")
    .evaluateAll((cells) => cells.filter((cell) => cell.getBoundingClientRect().width > 0).map((cell) => cell.textContent?.trim()));

test("sorting is a header button with aria-sort that keeps focus and reverses on the next press", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = pageErrors(page);
  try {
    await mount(page, 1000);
    const opened = page.getByRole("button", { name: "Opened", exact: true });
    await opened.focus();
    await page.keyboard.press("Enter");
    expect(await page.locator("th", { has: opened }).getAttribute("aria-sort")).toBe("descending");
    expect(await opened.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    expect(await page.locator("th", { has: opened }).getAttribute("aria-sort")).toBe("ascending");
    // Missing values stay last in both directions.
    expect(await page.locator("tbody tr.k2b-data-table__row td:first-child").allTextContents()).toEqual([
      "Autumn selection",
      "Weekly letter 44",
      "New in stock",
      "Trade fair invitation",
    ]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

test("search narrows the rows, an empty result says so at a fixed height, and Clear search returns to the field", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await mount(page, 1000);
    const search = page.getByRole("searchbox", { name: "Search Campaigns" });
    const tableTop = await page.locator("table").evaluate((table) => table.getBoundingClientRect().top);
    await search.fill("deliv");
    expect(await page.locator("tbody tr.k2b-data-table__row").count()).toBe(2);
    await search.fill("zebra");
    const empty = page.locator("td.k2b-data-table__no-match");
    expect(await empty.textContent()).toContain("No row matches “zebra”.");
    expect(await empty.evaluate((cell) => cell.getBoundingClientRect().height)).toBe(64);
    // The head and the table's top stay where they were.
    expect(await page.locator("table").evaluate((table) => table.getBoundingClientRect().top)).toBe(tableTop);
    // The field has its own clear button; this one is the table's way back.
    await empty.getByRole("button", { name: "Clear search", exact: true }).click();
    expect(await page.locator("tbody tr.k2b-data-table__row").count()).toBe(4);
    expect(await search.evaluate((input) => input === document.activeElement)).toBe(true);
  } finally {
    await page.close();
  }
}, 30_000);

test("grouping by status gives one body per group under a row-group header with its count", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await mount(page, 1000);
    await page.getByRole("combobox", { name: "Group rows" }).click();
    await page.getByRole("option", { name: "By Status" }).click();
    await page.locator("tbody.k2b-data-table__group").first().waitFor();
    expect(
      await page
        .locator("tbody.k2b-data-table__group")
        .evaluateAll((bodies) =>
          bodies.map((body) => [
            body.querySelector('th[scope="rowgroup"]')?.textContent,
            body.querySelectorAll(".k2b-data-table__row").length,
          ]),
        ),
    ).toEqual([
      ["Sending1, 1 row", 1],
      ["Delivered2, 2 rows", 2],
      ["Scheduled1, 1 row", 1],
    ]);
  } finally {
    await page.close();
  }
}, 30_000);

test("narrow tables drop priority 3 below 560 px and 2 below 420 px; row details bring the values back", async () => {
  // A fresh page per width: Solid delegates events on the document, and rewriting one document drops its listeners.
  for (const [width, headers] of [
    [700, ["Campaign", "Status", "Sent", "Recipients", "Opened", "Revenue"]],
    [520, ["Campaign", "Status", "Opened", "Revenue", "Details"]],
  ] as const) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    try {
      await mount(page, width);
      expect({ width, headers: await visibleHeaders(page) }).toEqual({ width, headers: [...headers] });
    } finally {
      await page.close();
    }
  }
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  try {
    await mount(page, 400);
    expect(await visibleHeaders(page)).toEqual(["Campaign", "Status", "Opened", "Details"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    // Tab reaches the first row's details button; Enter opens exactly the hidden values.
    const toggle = page.getByRole("button", { name: "Show the row's hidden values" }).first();
    await toggle.focus();
    const next = page.locator("tbody tr.k2b-data-table__row").nth(1);
    const before = await next.evaluate((row) => row.getBoundingClientRect().top);
    await page.keyboard.press("Enter");
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    const details = page.locator(`#${await toggle.getAttribute("aria-controls")}`);
    expect(await details.isVisible()).toBe(true);
    expect(
      await details
        .locator("dt")
        .evaluateAll((terms) => terms.filter((term) => term.getClientRects().length).map((term) => term.textContent)),
    ).toEqual(["Sent", "Recipients", "Revenue"]);
    expect(await details.locator("dd").allTextContents()).toContain("€2,140.00");
    // Closing restores the next rows exactly.
    await page.keyboard.press("Enter");
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    expect(await next.evaluate((row) => row.getBoundingClientRect().top)).toBe(before);
    // Wide again with a row still open: no toggle, no details line, nothing hidden, and the row keeps its line.
    await page.keyboard.press("Enter");
    await page.locator("#host").evaluate((host) => {
      host.style.width = "900px";
    });
    expect(
      await page
        .locator("tbody tr.k2b-data-table__row")
        .first()
        .locator("td")
        .first()
        .evaluate((cell) => getComputedStyle(cell).boxShadow),
    ).toContain("inset");
    expect(await toggle.isVisible()).toBe(false);
    expect(await visibleHeaders(page)).toEqual(["Campaign", "Status", "Sent", "Recipients", "Opened", "Revenue"]);
  } finally {
    await page.close();
  }
}, 30_000);
