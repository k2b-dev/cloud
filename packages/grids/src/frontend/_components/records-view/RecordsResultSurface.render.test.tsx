import { describe, expect, test } from "bun:test";
import { Button } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { PublicFieldSchema, PublicGridRecordSchema } from "../../../api/public-dto";
import "../ssr-test-plugin";

const { default: RecordsResultSurface } = await import("./RecordsResultSurface");

type SurfaceProps = Parameters<typeof RecordsResultSurface>[0];

const timestamp = "2026-01-01T00:00:00.000Z";
const nameField = PublicFieldSchema.parse({
  id: "FIELD1",
  tableId: "TABLE1",
  name: "Name",
  description: "",
  type: "text",
  config: {},
  position: 0,
  required: false,
  presentable: true,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const customerField = PublicFieldSchema.parse({
  ...nameField,
  id: "FIELD2",
  name: "Customer",
  type: "relation",
  config: { targetTableId: "TABLE2" },
  position: 1,
  presentable: false,
});
const record = PublicGridRecordSchema.parse({
  id: "REC001",
  tableId: "TABLE1",
  data: { FIELD1: "Invoice 1", FIELD2: ["REC002", "REC003"] },
  version: 1,
  createdBy: null,
  updatedBy: null,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const renderSurface = (mode: SurfaceProps["mode"], overrides: Partial<SurfaceProps> = {}): string =>
  renderToString(() =>
    createComponent(RecordsResultSurface, {
      grouped: false,
      mode,
      trashMode: false,
      loading: false,
      cursor: null,
      nextCursor: null,
      tableId: "TABLE1",
      viewId: null,
      baseId: "BASE01",
      fieldsByTable: {},
      fields: [nameField, customerField],
      items: [record],
      buckets: [],
      groupBy: [],
      aggregations: [],
      groupedExplode: false,
      relationLabels: { REC002: "Acme", REC003: "Globex" },
      selectedGroup: null,
      selectedRecordId: null,
      highlightedRecordIds: new Set<string>(),
      filePreviews: {},
      displayConfig: { mode, cards: { fieldIds: ["FIELD1", "FIELD2"] } },
      calendarState: { view: "month", date: "2026-01-01" },
      cardSize: "medium",
      viewColumns: undefined,
      aggregates: {},
      aggregationSpecs: [],
      groupedColumnOrder: [],
      hiddenGroupedColumnIds: undefined,
      adminMode: false,
      canManageTable: false,
      savedView: false,
      canEditView: false,
      resultNarrowed: false,
      onClearResultNarrowing: () => {},
      bulkSelection: undefined,
      onRecordClick: () => {},
      onCalendarChange: () => {},
      onGroupClick: () => {},
      onLoadMore: () => {},
      onFieldSettings: () => {},
      onViewColumnSettings: () => {},
      onViewColumnMove: () => {},
      onGroupedColumnSettings: () => {},
      onGroupedColumnMove: () => {},
      ...overrides,
    }),
  );

describe("RecordsResultSurface relation labels", () => {
  test("table cells name linked records and keep their links", () => {
    const html = renderSurface("table");

    expect(html).toContain("Acme");
    expect(html).toContain("Globex");
    expect(html).not.toContain("Unavailable record");
    expect(html).toContain("/app/grids/BASE01/table/TABLE2?record=REC002");
  });

  test("cards name linked records", () => {
    const html = renderSurface("cards");

    expect(html).toContain("Acme, Globex");
    expect(html).not.toContain("Unavailable record");
  });
});

describe("RecordsResultSurface empty table", () => {
  const addRecord = () => createComponent(Button, { type: "button", children: "Add record" });

  test("a table without records shows one empty state with the creation action instead of an empty grid", () => {
    const html = renderSurface("table", { items: [], emptyAction: addRecord() });

    expect(html).toContain("No records yet");
    expect(html).toContain("Records added to this table appear here.");
    expect(html).toContain("Add record");
    expect(html).toContain('data-variant="panel"');
    expect(html).not.toContain("<table");
  });

  test("readers see the empty state without an action", () => {
    const html = renderSurface("table", { items: [] });

    expect(html).toContain("No records yet");
    expect(html).not.toContain("k2b-placeholder__action");
  });

  test("edit mode, saved views, the trash and narrowed results keep their own empty presentation", () => {
    for (const overrides of [{ adminMode: true }, { savedView: true }, { trashMode: true }] satisfies Partial<SurfaceProps>[]) {
      const html = renderSurface("table", { items: [], emptyAction: addRecord(), ...overrides });
      expect(html).toContain("<table");
      expect(html).not.toContain("No records yet");
    }

    const narrowed = renderSurface("table", { items: [], resultNarrowed: true });
    expect(narrowed).toContain("No matching records");
    expect(narrowed).not.toContain("No records yet");
  });

  test("a table that is still loading keeps the grid until the result arrives", () => {
    const html = renderSurface("table", { items: [], loading: true });

    expect(html).toContain("<table");
    expect(html).not.toContain("No records yet");
  });
});
