import { describe, expect, test } from "bun:test";
import type { PublicField as Field, PublicGridRecord as GridRecord } from "../../../api/public-dto";
import { resolveFieldDisplay } from "./field-display";
import { fieldDisplayFormat, formatFieldValueText, relationIds } from "./field-value-format";

const field = (overrides: Partial<Field> & Pick<Field, "id" | "name" | "type">): Field => ({
  tableId: "tbl",
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
  id: "rec",
  tableId: "tbl",
  data,
  expanded,
  version: 1,
  createdBy: null,
  updatedBy: null,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("FieldValue helpers", () => {
  test("normalizes relation ids from scalar and multi-value storage", () => {
    expect(relationIds("r1")).toEqual(["r1"]);
    expect(relationIds(["r1", "", 42, "r2"])).toEqual(["r1", "r2"]);
    expect(relationIds(null)).toEqual([]);
  });

  test("formats relation labels from explicit labels before expanded record data", () => {
    const relation = field({ id: "rel", name: "Author", type: "relation" });
    const rec = record({ rel: ["a1", "a2"] }, { a1: { Name: "Expanded author" }, a2: { Name: "Second author" } });

    expect(
      formatFieldValueText({
        field: relation,
        value: rec.data.rel,
        record: rec,
        relationLabels: { a1: "Cached author" },
      }),
    ).toBe("Cached author, Second author");
  });

  test("formats select values with configured labels", () => {
    const status = field({
      id: "status",
      name: "Status",
      type: "select",
      config: { options: [{ id: "ready", label: "Ready" }] },
    });

    expect(formatFieldValueText({ field: status, value: "ready" })).toBe("Ready");
  });

  test("formats lookup values with the target field metadata", () => {
    const relation = field({ id: "rel", name: "Book", type: "relation", config: { targetTableId: "books" } });
    const lookup = field({
      id: "price_lookup",
      name: "Price",
      type: "lookup",
      config: { relationFieldId: "rel", targetFieldId: "price" },
    });
    const price = field({ id: "price", tableId: "books", name: "Price", type: "number", config: { unit: "EUR" } });

    expect(formatFieldValueText({ field: lookup, value: "12", fieldsByTable: { tbl: [relation, lookup], books: [price] } })).toBe("12 EUR");
  });

  test("prefers explicit view format over field config format", () => {
    const amount = field({
      id: "amount",
      name: "Amount",
      type: "number",
      config: { format: { kind: "decimal", precision: 0, thousandsSeparator: false } },
    });

    expect(fieldDisplayFormat(amount, { kind: "decimal", precision: 2, thousandsSeparator: true })).toEqual({
      kind: "decimal",
      precision: 2,
      thousandsSeparator: true,
    });
  });

  test("returns explicit empty and markdown display intents", () => {
    const notes = field({ id: "notes", name: "Notes", type: "longtext", config: { markdown: true } });

    expect(resolveFieldDisplay({ field: notes, value: null })).toEqual({ kind: "empty" });
    expect(resolveFieldDisplay({ field: notes, value: "**Ready**" })).toEqual({ kind: "markdown", text: "**Ready**" });
  });

  test("preserves select metadata for badge renderers", () => {
    const status = field({
      id: "status",
      name: "Status",
      type: "select",
      config: { options: [{ id: "ready", label: "Ready", color: "#16a34a" }] },
    });

    expect(resolveFieldDisplay({ field: status, value: ["ready", "missing"] })).toEqual({
      kind: "select",
      text: "Ready, missing",
      items: [
        { id: "ready", label: "Ready", color: "#16a34a", known: true },
        { id: "missing", label: "missing", known: false },
      ],
    });
    expect(formatFieldValueText({ field: status, value: 42 })).toBe("42");
  });

  test("returns relation link metadata or label-only values by context", () => {
    const relation = field({
      id: "rel",
      name: "Author",
      type: "relation",
      config: { targetTableId: "authors" },
    });

    expect(resolveFieldDisplay({ field: relation, value: "a1", relationLabels: { a1: "Ada" } })).toEqual({
      kind: "relation",
      items: [{ id: "a1", label: "Ada", linkable: true }],
      targetTableId: "authors",
    });
    expect(resolveFieldDisplay({ field: relation, value: "Ada", relationValueMode: "labels" })).toEqual({
      kind: "relation",
      items: [{ id: "Ada", label: "Ada", linkable: false }],
    });
  });

  test("renders visible principal labels without exposing hidden UUIDs", () => {
    const participants = field({ id: "participants", name: "Participants", type: "principal" });
    expect(
      resolveFieldDisplay({
        field: participants,
        value: [
          { type: "user", id: "u1" },
          { type: "group", id: "g1" },
        ],
        relationLabels: { u1: "Ada", g1: "Design team" },
      }),
    ).toEqual({ kind: "principal", text: "Ada, Design team" });
    expect(resolveFieldDisplay({ field: participants, value: [{ type: "user", id: "hidden" }] })).toEqual({
      kind: "principal",
      text: "Private user",
    });
    expect(resolveFieldDisplay({ field: participants, value: [{ type: "user", id: "hidden" }], locale: "de-CH" })).toEqual({
      kind: "principal",
      text: "Privater Benutzer",
    });
    expect(resolveFieldDisplay({ field: participants, value: ["Ada", "Design team"] })).toEqual({
      kind: "principal",
      text: "Ada, Design team",
    });
  });

  test("normalizes date, barcode, and progress display semantics", () => {
    const due = field({ id: "due", name: "Due", type: "date" });
    const code = field({ id: "code", name: "Code", type: "text" });
    const completion = field({ id: "completion", name: "Completion", type: "percent" });

    expect(resolveFieldDisplay({ field: due, value: "2026-07-12T14:30:00.000Z" })).toEqual({
      kind: "text",
      text: "2026-07-12",
    });
    expect(resolveFieldDisplay({ field: code, value: "ITEM-42", format: { kind: "barcode", bcid: "code128" } })).toEqual({
      kind: "barcode",
      value: "ITEM-42",
      format: { kind: "barcode", bcid: "code128" },
    });
    expect(resolveFieldDisplay({ field: completion, value: 75, format: { kind: "progress", label: "percent" } })).toEqual({
      kind: "progress",
      ratio: 0.75,
      label: "75%",
      text: "75%",
      format: { kind: "progress", label: "percent" },
    });
  });

  test("keeps structured file values available as deterministic text", () => {
    const attachment = field({ id: "attachment", name: "Attachment", type: "file" });

    expect(resolveFieldDisplay({ field: attachment, value: { name: "invoice.pdf", size: 42 } })).toEqual({
      kind: "text",
      text: '{"name":"invoice.pdf","size":42}',
    });
  });
});
