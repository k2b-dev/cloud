import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { Field, GridRecord } from "../../../service";
import "../ssr-test-plugin";

const { default: RecordReadView, hasRecordDetailValue } = await import("./RecordReadView");

const field = (overrides: Partial<Field> & Pick<Field, "id" | "name" | "type">): Field => ({
  shortId: overrides.id.slice(0, 6),
  tableId: "table",
  description: null,
  config: {},
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const record = (data: Record<string, unknown>): GridRecord =>
  ({
    id: "12345678-abcd-4000-8000-000000000000",
    tableId: "table",
    data,
    version: 2,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }) as GridRecord;

describe("RecordReadView", () => {
  test("copies a live record's Cloud ID through the shared menu entry", async () => {
    const source = await Bun.file(new URL("./RecordReadView.tsx", import.meta.url)).text();

    expect(source).toContain('mode() === "live" ? cloudId.section({ type: "grids.record", id: props.record.id })');
    expect(source).not.toContain("window.location");
  });

  test("renders the shared outline: table as kind, field rows, and technical details under More about", () => {
    const name = field({ id: "name", name: "Name", type: "text", presentable: true });
    const room = field({ id: "room", name: "Room", type: "text" });
    const notes = field({ id: "notes", name: "Notes", type: "longtext" });

    const html = renderToString(() =>
      createComponent(RecordReadView, {
        baseId: "base",
        tableId: "table",
        tableName: "Locations",
        fields: [name, room, notes],
        record: record({ name: "Studio shelf", room: "Studio", notes: "" }),
        menuItems: [{ label: "Print label", icon: "ti ti-printer", action: () => undefined }],
      }),
    );

    expect(html).toContain("k2b-detail-panel__header");
    expect(html).toContain("k2b-detail-panel__body");
    expect(html).toMatch(/k2b-detail-panel__kind"><span>Locations<\/span>/);
    expect(html).not.toContain("ti-table-row");
    expect(html).not.toContain("k2b-detail-panel__header-icon");
    expect(html).toContain("Studio shelf");
    expect(html).toContain("Version 2 · changed");
    expect(html).toContain("More record actions");
    // Technical details: the ID, collapsed under "More about this record"; Cloud ID lives in "…".
    expect(html).toContain("More about this record");
    expect(html).toContain("Technical details");
    expect(html).toContain("ID, version, dates");
    expect(html).toContain("12345678-abcd-4000-8000-000000000000");
    expect(html).not.toContain("Copy record reference");
    expect(html).not.toContain(">Draft<");
    expect(html).not.toContain("font-mono");
    expect(html).toContain("Fields");
    expect(html).not.toContain("ti-list-details");
    expect(html).not.toContain("k2b-detail-panel__section-icon");
    expect(html).toContain("Room");
    expect(html).not.toContain(">Notes<");
    expect(html).not.toContain("detail-stack");
    expect(html).not.toContain("detail-section-label");
    // Fields come before the "More about" group.
    expect(html.indexOf("Room")).toBeLessThan(html.indexOf("More about this record"));
  });

  test("says quietly that a record has no values yet and offers no copy command for snapshots", () => {
    const name = field({ id: "name", name: "Name", type: "text", presentable: true });
    const html = renderToString(() =>
      createComponent(RecordReadView, {
        baseId: "base",
        tableId: "table",
        tableName: "Locations",
        fields: [name],
        record: record({ name: "Studio shelf" }),
        mode: "snapshot",
        subtitle: "Snapshot from yesterday",
      }),
    );

    expect(html).toContain("No record values yet.");
    expect(html).toContain("Snapshot from yesterday");
    expect(html).toContain(">Snapshot<");
    expect(html).not.toContain("Copy record reference");
    expect(html).not.toContain("More record actions");
  });

  test("shows finalization state only for opted-in tables or finalized records", () => {
    const name = field({ id: "name", name: "Name", type: "text", presentable: true });
    const draftHtml = renderToString(() =>
      createComponent(RecordReadView, {
        baseId: "base",
        tableId: "table",
        tableName: "Items",
        fields: [name],
        record: record({ name: "Draft item" }),
        showFinalizationStatus: true,
      }),
    );
    const finalizedHtml = renderToString(() =>
      createComponent(RecordReadView, {
        baseId: "base",
        tableId: "table",
        tableName: "Items",
        fields: [name],
        record: { ...record({ name: "Final item" }), finalizedAt: "2026-08-18T12:00:00.000Z" },
        showFinalizationStatus: true,
      }),
    );

    expect(draftHtml).toMatch(/k2b-detail-panel__kind"><span>Items<\/span>.*Finalization on · Draft/s);
    expect(draftHtml).toContain("ti-pencil");
    expect(finalizedHtml).toContain(">Finalized<");
    expect(finalizedHtml).toContain("ti-lock");
  });

  test("lists relations under Linked, followed by reverse-relation content", () => {
    const name = field({ id: "name", name: "Name", type: "text", presentable: true });
    const relation = field({
      id: "camera",
      name: "Category",
      type: "relation",
      description: "Reusable equipment category.",
      config: { targetTableId: "cameras" },
    });
    const html = renderToString(() =>
      createComponent(RecordReadView, {
        baseId: "base",
        tableId: "table",
        tableName: "Loans",
        fields: [name, relation],
        record: record({ name: "Loan", camera: ["CAM001"] }),
        relationLabels: { CAM001: "Sony FX3" },
        relationsAfter: "Referenced by content",
      }),
    );

    expect(html).toContain("Linked");
    expect(html).toContain("Category · Sony FX3");
    expect(html).toContain("Reusable equipment category.");
    expect(html).toContain("k2b-detail-panel__action");
    expect(html).not.toContain("ti-chevron-right");
    expect(html).toContain("Referenced by content");
    expect(html.indexOf("Category · Sony FX3")).toBeLessThan(html.indexOf("Referenced by content"));
    expect(html).not.toContain("Unknown record");
    expect(html).not.toContain("No record values yet");
  });

  test("treats only missing and empty string values as absent", () => {
    expect(hasRecordDetailValue(null)).toBe(false);
    expect(hasRecordDetailValue(undefined)).toBe(false);
    expect(hasRecordDetailValue("")).toBe(false);
    expect(hasRecordDetailValue(0)).toBe(true);
    expect(hasRecordDetailValue(false)).toBe(true);
    expect(hasRecordDetailValue([])).toBe(true);
  });

  test("keeps snapshot relation labels as text instead of live record destinations", () => {
    const relation = field({ id: "rel001", name: "Customer", type: "relation", config: { targetTableId: "TABLE2" } });
    const html = renderToString(() =>
      createComponent(RecordReadView, {
        baseId: "BASE01",
        tableId: "TABLE1",
        tableName: "Invoices",
        fields: [relation],
        record: record({ rel001: ["REC002"] }),
        relationLabels: { REC002: "Historic customer" },
        mode: "snapshot",
      }),
    );
    expect(html).toContain("Historic customer");
    expect(html).not.toContain("?record=");
    expect(html).not.toContain("Unavailable record");
  });

  test("exposes HTML templates only through the preview action in the detail body", () => {
    const template = field({ id: "html01", name: "Letter", type: "html_template" });
    const html = renderToString(() =>
      createComponent(RecordReadView, {
        baseId: "BASE01",
        tableId: "TABLE1",
        tableName: "Letters",
        fields: [template],
        record: record({ html01: "<script>danger()</script><b>Private letter</b>" }),
      }),
    );
    expect(html).toContain("Preview");
    expect(html).not.toContain("danger()");
    expect(html).not.toContain("Private letter");
    expect(html).not.toContain("<iframe");
  });
});
