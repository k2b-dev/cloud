import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-cloud-descriptions-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { DescriptionPanel, resolveDescription } = await import("./index");
const { LocaleProvider } = await import("@k2b/ui");
type DescriptionJson = import("./json").DescriptionJson;
type Props = Parameters<typeof DescriptionPanel>[0];
const panel = (props: Props, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(DescriptionPanel, props);
      },
    }),
  );

test("a table block draws in the dashboard frame with search in its head and every row reserved", () => {
  const html = panel({
    spec: { block: "table", title: "Campaigns", search: true, columns: [{ id: "name", label: "Campaign" }], rows: [{ name: "Weekly" }] },
    title: "Campaigns",
    height: 260,
    width: "full",
  });
  expect(html).toContain("k2b-dashboard-frame");
  expect(html).toContain('data-width="full"');
  expect(html).toContain("k2b-dashboard-frame__reserve");
  expect(html).toContain('aria-label="Search Campaigns"');
});

test("a table without rows keeps the read's state in its head and says why below", () => {
  const html = panel({
    spec: { block: "table", title: "Payments", columns: [{ id: "due", label: "Due" }], rows: [] },
    title: "Payments",
    height: 260,
    state: "stale",
    asOf: "09:12",
    onRetry: () => {},
    empty: "No payments are planned.",
  });
  expect(html).toContain("As of 09:12");
  expect(html).toContain("No payments are planned.");
});

test("key figures name the time of a stale read, in the reader's language", () => {
  const spec = { block: "stats", items: [{ label: "Subscribers", value: 48210 }] };
  expect(panel({ spec, title: "Key figures", height: 0, state: "stale", asOf: "09:12" })).toContain("As of 09:12 · not current");
  expect(panel({ spec, title: "Key figures", height: 0, state: "stale", asOf: "09:12" }, "de")).toContain("Stand 09:12 · nicht aktuell");
});

test("tables of charts only the Solid component draws follow the requested locale", () => {
  const map = resolveDescription(
    { kind: "map", series: [{ data: [{ label: "Berlin", latitude: 52.52, longitude: 13.405, size: 1200.5 }] }] },
    "de",
  );
  if (map.mode !== "live") throw new Error(`expected a live drawing, got ${map.mode}`);
  expect(map.columns.map((column) => column.label)).toEqual(["Ort", "Breite", "Länge", "Größe"]);
  expect(map.rows[0]!.cells.latitude).toBe("52,52°");
  expect(map.rows[0]!.cells.size).toBe("1.200,5");
});

const items: DescriptionJson[] = [
  { label: "Amount", type: "number", value: 2380, format: { style: "currency", currency: "EUR" } },
  { label: "Due", type: "date", value: "2026-11-09" },
  { label: "Note", type: "text", value: null },
];
const details = { block: "details", title: "Invoice 2026-118", subtitle: "Customer payment", items };

test("a details block draws the record's fields in the dashboard frame, formatted like Chat's details view", () => {
  const html = panel({ spec: details, title: "Details", height: 160, width: "third" });
  expect(html).toContain("k2b-dashboard-frame");
  expect(html).toContain("Invoice 2026-118");
  expect(html).toContain("€2,380.00");
  expect(html).toContain("Amount");
  // A missing value is a dash, never an empty row.
  expect(html).toContain("—");
  expect(html).not.toContain("This view cannot be shown here.");
  expect(resolveDescription(details).mode).toBe("block");
});

test("details keep their frame and height in every state and name a stale read's time", () => {
  for (const state of ["loading", "empty", "error", "stale"] as const) {
    const html = panel({ spec: details, title: "Details", height: 160, state, asOf: "09:12", onRetry: () => {}, empty: "No record." });
    expect(html, state).toContain('style="height:160px"');
    if (state === "empty") expect(html).toContain("No record.");
    if (state === "error") expect(html).toContain("The data could not be loaded.");
    if (state === "stale") expect(html).toContain("As of 09:12");
  }
});

test("details that break Chat's strict form show the slot, never a guess", () => {
  expect(resolveDescription({ ...details, items: [{ label: "Amount", type: "number", value: "a lot" }] })).toMatchObject({
    mode: "slot",
    kind: "details",
  });
  expect(resolveDescription({ ...details, extra: true }).mode).toBe("slot");
});

test("a chart with only its kind, title and empty sentence draws the chart frame's empty state", () => {
  const spec = { kind: "line", title: "Revenue", subtitle: "October", empty: "No revenue yet." };
  expect(resolveDescription(spec)).toEqual({ mode: "empty", kind: "line", empty: "No revenue yet." });
  const html = panel({ spec, title: "Revenue", height: 240 });
  expect(html).toContain("k2b-chart-explorer");
  expect(html).toContain('data-state="empty"');
  expect(html).toContain("No revenue yet.");
  // The host's sentence wins; a failed read stays a failure.
  expect(panel({ spec, title: "Revenue", height: 240, state: "empty", empty: "Nothing sent." })).toContain("Nothing sent.");
  expect(panel({ spec, title: "Revenue", height: 240, state: "error", onRetry: () => {} })).toContain('data-state="error"');
});

test("the empty form is explicit and strict: any other field, an unknown kind or a missing title keeps the old answer", () => {
  // Any field beyond kind, title, subtitle and empty sends the description through the strict schema as before.
  expect(resolveDescription({ kind: "line", title: "Revenue", series: [], empty: "No revenue yet." }).mode).not.toBe("empty");
  expect(resolveDescription({ kind: "stat", title: "Revenue", empty: "None", value: "x" }).mode).toBe("slot");
  expect(resolveDescription({ kind: "line", title: "Revenue", empty: 3 }).mode).toBe("slot");
  expect(resolveDescription({ kind: "notAKind", title: "Revenue" }).mode).toBe("slot");
  expect(resolveDescription({ kind: "line", title: " " }).mode).toBe("slot");
  expect(resolveDescription({ kind: "map", title: "Shops", empty: "No shop yet." }).mode).toBe("empty");
});

test("calendar description panels retain their content-sized reserve in every state and view", () => {
  const spec = {
    kind: "heatmap",
    layout: "calendar",
    title: "Opens per day",
    scale: "sequential",
    data: Array.from({ length: 182 }, (_, day): [string, number] => [
      new Date(Date.UTC(2026, 4, 11) + day * 86400000).toISOString().slice(0, 10),
      day,
    ]),
  };
  const reserve = "calc(16px + (0.3414141414141414 * clamp(495px, var(--k2b-calendar-available,100cqw), 1131.43px)))";
  for (const state of ["ready", "loading", "empty", "error", "stale"] as const) {
    for (const view of ["chart", "table"] as const) {
      const html = panel({ spec, title: spec.title, height: 280, state, view, onRetry: () => {} });
      const viewport = html.match(/<div[^>]*class="k2b-chart-explorer__viewport"[^>]*>/)?.[0];
      expect(viewport, `${state}/${view}`).toBeDefined();
      expect(viewport).toContain('data-calendar="true"');
      expect(viewport).not.toContain("height:280px");
      const actualReserve = viewport!.match(/--k2b-calendar-height:([^;"}]+)/)?.[1];
      // A populated inset table extends into the panel padding, preserving the outer box.
      const insetTable = view === "table" && (state === "ready" || state === "stale");
      expect(actualReserve, `${state}/${view}`).toBe(insetTable ? `calc(${reserve} + 1rem)` : reserve);
    }
  }
});
