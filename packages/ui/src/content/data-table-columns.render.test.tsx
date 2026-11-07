import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-data-table-columns-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: DataTable } = await import("./DataTable");
const { LocaleProvider } = await import("../intl/locale");
const { filterRows, groupRows, sortRows, tableCellText } = await import("./data-table-columns");
const { createDataTableView } = await import("./DataTableTools");
const { createRoot } = await import("solid-js");

type Campaign = { name: string; status: string; date: string; to: number; open: number | null; rev: number | null };
// Invented campaigns.
const rows: Campaign[] = [
  { name: "Autumn selection", status: "sending", date: "2026-11-06", to: 46900, open: 0.314, rev: 2140 },
  { name: "Weekly letter 44", status: "delivered", date: "2026-10-29", to: 46720, open: 0.492, rev: 4610 },
  { name: "Trade fair invitation", status: "scheduled", date: "2026-11-12", to: 47000, open: null, rev: null },
  { name: "Neue Ware im Lager", status: "delivered", date: "2026-10-22", to: 46510, open: 0.526, rev: 6380 },
];
const states = {
  sending: { label: "Sending", tone: "running" as const },
  delivered: { label: "Delivered", tone: "ok" as const },
  scheduled: { label: "Scheduled", tone: "neutral" as const },
};
const columns = [
  { id: "name", header: "Campaign", value: "name" as const, type: "text" as const },
  { id: "status", header: "Status", value: "status" as const, type: "status" as const, states },
  { id: "date", header: "Sent", value: "date" as const, type: "date" as const, priority: 3 as const },
  { id: "to", header: "Recipients", value: "to" as const, type: "number" as const, priority: 3 as const },
  { id: "open", header: "Opened", value: "open" as const, type: "bar" as const, format: { style: "percent" as const }, max: 0.6 },
  { id: "rev", header: "Revenue", value: "rev" as const, type: "amount" as const, format: { currency: "EUR" }, priority: 2 as const },
];
// Hydration keys and Solid's own placeholder comments are not part of the markup contract.
const solidMarkers = ["<!--$-->", "<!--/-->", "<!--!$-->"];
const strip = (html: string) => solidMarkers.reduce((text, marker) => text.replaceAll(marker, ""), html.replace(/ data-hk="[^"]*"/g, ""));
const render = (props: Record<string, unknown>, locale = "en") =>
  strip(
    renderToString(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(DataTable<Campaign>, { columns, rows, ariaLabel: "Campaigns", ...props });
        },
      }),
    ),
  );

test("a typed cell shows what its type reads, in the reader's language", () => {
  expect(tableCellText(4610, columns[5]!, "de")).toBe("4.610,00 €");
  expect(tableCellText(0.492, columns[4]!, "en")).toBe("49.2%");
  expect(tableCellText("2026-10-29", columns[2]!, "de")).toBe("29.10.2026");
  // A time reads in the column's zone, so every reader and the server show the same clock.
  expect(tableCellText("2026-10-20T14:32:00Z", { type: "date", timeZone: "Europe/Berlin" }, "de")).toBe("20.10.2026, 16:32");
  expect(tableCellText("delivered", columns[1]!, "en")).toBe("Delivered");
  expect(tableCellText(null, columns[5]!, "en")).toBe("");
});

test("search matches the shown text without case or accents, and an empty query keeps every row", () => {
  expect(filterRows(rows, columns, "  ", "en")).toHaveLength(4);
  expect(filterRows(rows, columns, "deliv", "en").map((row) => row.name)).toEqual(["Weekly letter 44", "Neue Ware im Lager"]);
  expect(filterRows(rows, columns, "LAGER", "de").map((row) => row.name)).toEqual(["Neue Ware im Lager"]);
  expect(filterRows([{ ...rows[0]!, name: "Café Süd" }], columns, "cafe sud", "de")).toHaveLength(1);
  // A status matches by its label, not by its stored key.
  expect(filterRows(rows, columns, "sending", "en")).toHaveLength(1);
  expect(filterRows(rows, columns, "6,380", "en").map((row) => row.name)).toEqual(["Neue Ware im Lager"]);
});

test("sorting puts missing values last in both directions and keeps ties in their order", () => {
  const sorted = (direction: "asc" | "desc") => sortRows(rows, columns, { key: "open", direction }, "en").map((row) => row.open);
  expect(sorted("asc")).toEqual([0.314, 0.492, 0.526, null]);
  expect(sorted("desc")).toEqual([0.526, 0.492, 0.314, null]);
  expect(sortRows(rows, columns, { key: "status", direction: "asc" }, "en").map((row) => row.status)).toEqual([
    "delivered",
    "delivered",
    "scheduled",
    "sending",
  ]);
  expect(sortRows(rows, columns, { key: "date", direction: "desc" }, "en").map((row) => row.date)[0]).toBe("2026-11-12");
});

test("a grouped view lists its rows in the order the table shows them, so selection follows the screen", () => {
  createRoot((dispose) => {
    // The server build of Solid computes once, so the group comes in as the starting state.
    const view = createDataTableView({ rows: () => rows, columns: () => columns, groupBy: "status" });
    expect(view.rows().map((row) => row.name)).toEqual([
      "Autumn selection",
      "Weekly letter 44",
      "Neue Ware im Lager",
      "Trade fair invitation",
    ]);
    dispose();
  });
});

test("dates sort by time whether they come as ISO text or as epoch milliseconds", () => {
  const stamps = [{ at: Date.UTC(2026, 9, 2) }, { at: Date.UTC(2026, 10, 6) }, { at: Date.UTC(2026, 9, 22) }];
  const at = [{ id: "at", value: "at" as const, type: "date" as const }];
  expect(sortRows(stamps, at, { key: "at", direction: "desc" }, "en").map((row) => row.at)).toEqual([
    Date.UTC(2026, 10, 6),
    Date.UTC(2026, 9, 22),
    Date.UTC(2026, 9, 2),
  ]);
});

test("groups keep the order they first appear in and take their label from the shown value", () => {
  expect(groupRows(rows, columns[1]!, "en").map((group) => [group.label, group.rows.length])).toEqual([
    ["Sending", 1],
    ["Delivered", 2],
    ["Scheduled", 1],
  ]);
});

test("typed columns align numbers right, let text wrap and draw status, bars and amounts", () => {
  const html = render({});
  expect(html).toMatch(/<td[^>]*data-wrap="true"[^>]*>.*?Autumn selection/);
  expect(html).toContain('class="k2b-status-badge " data-tone="running" data-variant="dot"');
  expect(html).toContain("Sending");
  expect(html).toMatch(/<td[^>]*data-nowrap="true"[^>]*data-align="right"[^>]*data-priority="2"/);
  expect(html).toContain("€4,610.00");
  // 31.4 % of a track that is full at 60 %.
  expect(html).toContain('style="width:52.33333333333333%"');
  expect(html).toContain("31.4%");
  // A missing value is a dash, never a zero.
  expect(html).not.toContain("€0.00");
});

test("groupBy renders one body per group under a row-group header with its count", () => {
  const html = render({ groupBy: "status" });
  expect(html.match(/<tbody class="k2b-data-table__group">/g)?.length).toBe(3);
  expect(html).toContain(
    '<th scope="rowgroup" colspan="7">Delivered<span class="k2b-data-table__group-count"><span aria-hidden="true">2</span>',
  );
  expect(html).toContain('<span class="k2b-sr-only">, 2 rows</span>');
});

test("priorities add one details toggle per row whose details list the columns a narrow table hides", () => {
  const html = render({});
  expect(html).toContain('data-priorities="3"');
  expect(html.match(/class="k2b-data-table__details-button"/g)?.length).toBe(4);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-label="Show the row\'s hidden values"');
  const details = html.match(/<tr class="k2b-data-table__details"[^>]*hidden[^>]*>.*?<\/tr>/)?.[0] ?? "";
  expect(details).toContain('<div data-priority="3"><dt>Sent</dt>');
  expect(details).toContain('<div data-priority="2"><dt>Revenue</dt>');
  expect(details).not.toContain("<dt>Campaign</dt>");
  // Each details line gets its own label, also from a heading function, and hidden totals stay under the totals row.
  const labelled = render({
    columns: columns.map((column) => (column.id === "rev" ? { ...column, header: () => "Revenue (EUR)" } : column)),
    footer: { values: { name: "Total", rev: 13130 } },
  });
  expect(labelled.match(/<dt>Revenue \(EUR\)<\/dt>/g)?.length).toBe(5);
  expect(labelled).toMatch(/k2b-data-table__footer-details.*?<dt>Revenue \(EUR\)<\/dt><dd>€13,130.00<\/dd>/);
  // Without priorities nothing is added.
  const plain = render({ columns: columns.map(({ priority: _priority, ...column }) => column) });
  expect(plain).not.toContain("k2b-data-table__details");
  expect(plain).not.toContain("data-priorities");
});

test("no row left after a search says so and offers to clear it, in the reader's language", () => {
  const en = render({ rows: [], query: "zebra", onClearQuery: () => undefined });
  expect(en).toContain("No row matches “zebra”.");
  expect(en).toContain('<button type="button" class="k2b-data-table__clear-query">Clear search</button>');
  expect(en).not.toContain("No records");
  const de = render({ rows: [], query: "Zebra", onClearQuery: () => undefined }, "de");
  expect(de).toContain("Keine Zeile passt zu „Zebra“.");
  expect(de).toContain("Suche löschen");
  // Without a query the table keeps its own empty sentence.
  expect(render({ rows: [], empty: "No campaign sent yet." })).toContain("No campaign sent yet.");
});
