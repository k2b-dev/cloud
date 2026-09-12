import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PublicField as Field, PublicGridRecord as GridRecord } from "../../../api/public-dto";
import "../ssr-test-plugin";

const { FieldValue } = await import("./FieldValue");

const field = (overrides: Partial<Field> & Pick<Field, "id" | "name" | "type">): Field => ({
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

const record = (data: Record<string, unknown>, expanded?: GridRecord["expanded"]): GridRecord => ({
  id: "record",
  tableId: "table",
  data,
  expanded,
  version: 1,
  createdBy: null,
  updatedBy: null,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("FieldValue rendering", () => {
  test("shows a separate list diagnostic instead of presenting invalid rows as usable", () => {
    const list = field({ id: "Items1", name: "Items", type: "object_list" });
    const source = { ...record({ Items1: [{ Amount: null }] }), fieldErrors: { Items1: "Amount is required." } };
    const html = renderToString(() => createComponent(FieldValue, { field: list, value: source.data.Items1, record: source }));
    expect(html).toContain("Amount is required.");
    expect(html).not.toContain("1 row");
    expect(source.data.Items1).toEqual([{ Amount: null }]);
  });

  test("keeps HTML template values escaped and exposes a tall preview action", async () => {
    const htmlField = field({ id: "html01", name: "Email body", type: "html_template" });
    const html = renderToString(() => createComponent(FieldValue, { field: htmlField, value: "<strong>Ada</strong>" }));
    const detail = renderToString(() => createComponent(FieldValue, { field: htmlField, value: "<strong>Ada</strong>", mode: "detail" }));
    expect(html).toContain("&lt;strong>Ada&lt;/strong>");
    expect(html).toContain("Preview");
    expect(html).not.toContain("<strong>Ada</strong>");
    expect(detail).toContain("Preview");
    expect(detail).not.toContain("&lt;strong>Ada&lt;/strong>");

    const source = await Bun.file(new URL("./FieldValue.tsx", import.meta.url)).text();
    expect(source).toContain("panelDialogFixedOptions");
    expect(source).toContain("h-[65dvh] min-h-[24rem]");
  });

  test("renders relation links and label-only relation values", () => {
    const relation = field({ id: "author", name: "Author", type: "relation", config: { targetTableId: "authors" } });
    const linked = renderToString(() =>
      createComponent(FieldValue, {
        field: relation,
        value: "author-1",
        relationLabels: { "author-1": "Ada Lovelace" },
        baseId: "base",
      }),
    );
    const labels = renderToString(() =>
      createComponent(FieldValue, { field: relation, value: "Ada Lovelace", relationValueMode: "labels" }),
    );

    expect(linked).toContain("/app/grids/base/table/authors?record=author-1");
    expect(linked).toContain("Ada Lovelace");
    expect(labels).not.toContain("<a");
    expect(labels).toContain("Ada Lovelace");

    const unavailable = renderToString(() =>
      createComponent(FieldValue, { field: relation, value: "author-2", baseId: "base", mode: "detail" }),
    );
    expect(unavailable).toContain("Unavailable record");
    expect(unavailable).not.toContain("Unknown record");
  });

  test("renders select badges, markdown, and empty detail values", () => {
    const status = field({
      id: "status",
      name: "Status",
      type: "select",
      config: { options: [{ id: "ready", label: "Ready", color: "purple" }] },
    });
    const notes = field({ id: "notes", name: "Notes", type: "longtext", config: { markdown: true } });

    for (const mode of ["table", "card", "detail"] as const) {
      const html = renderToString(() => createComponent(FieldValue, { field: status, value: "ready", mode }));
      expect(html).toContain("Ready");
      expect(html).toContain("--k2b-choice-color:#800080");
    }
    expect(renderToString(() => createComponent(FieldValue, { field: notes, value: "**Important**" }))).toContain(
      "<strong>Important</strong>",
    );
    expect(renderToString(() => createComponent(FieldValue, { field: notes, value: null, mode: "detail" }))).toContain("—");
  });

  test("renders lookup links, barcodes, and progress displays from shared intents", () => {
    const relation = field({ id: "author", name: "Author", type: "relation", config: { targetTableId: "authors" } });
    const lookup = field({
      id: "author_name",
      name: "Author name",
      type: "lookup",
      config: { relationFieldId: relation.id, targetFieldId: "name" },
    });
    const target = field({ id: "name", tableId: "authors", name: "Name", type: "text" });
    const itemCode = field({ id: "code", name: "Code", type: "text" });
    const completion = field({ id: "completion", name: "Completion", type: "percent" });
    const row = record({ author: ["author-1"], author_name: "Ada Lovelace" });

    const lookupHtml = renderToString(() =>
      createComponent(FieldValue, {
        field: lookup,
        value: "Ada Lovelace",
        record: row,
        allFields: [relation, lookup],
        fieldsByTable: { table: [relation, lookup], authors: [target] },
        baseId: "base",
        linkLookup: true,
      }),
    );
    const barcodeHtml = renderToString(() =>
      createComponent(FieldValue, { field: itemCode, value: "ITEM-42", format: { kind: "barcode", bcid: "code128" } }),
    );
    const progressHtml = renderToString(() =>
      createComponent(FieldValue, { field: completion, value: 75, format: { kind: "progress", label: "percent" } }),
    );

    expect(lookupHtml).toContain("/app/grids/base/table/authors?record=author-1");
    expect(lookupHtml).toContain("Ada Lovelace");
    expect(barcodeHtml).toContain("grids-code-display--linear");
    expect(barcodeHtml).toContain("ITEM-42");
    expect(progressHtml).toContain("75%");
  });
});
