import { describe, expect, test } from "bun:test";
import type { PublicDslQueryPreviewResponse } from "../../../api/gql-public";
import type { PublicField as Field, PublicTable as Table, PublicView as View } from "../../../api/public-dto";
import {
  currentSourceForApi,
  previewSummary,
  queryTextStats,
  sourceCatalogSummary,
  sourceFieldsForSearch,
  visibleFields,
  visibleViews,
} from "./query-workspace-model";

const table = (id: string, deletedAt: string | null = null): Table => ({
  id,
  baseId: "base",
  kind: "stored",
  name: id,
  description: null,
  icon: null,
  columns: [],
  displayConfig: { mode: "table" },
  auditPolicy: {},
  mutationPolicy: { mode: "all" },
  position: 0,
  disableDirectInsert: false,
  deletedAt,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const field = (id: string, tableId: string, deletedAt: string | null = null): Field => ({
  id,
  tableId,
  name: id,
  description: null,
  icon: null,
  type: "text",
  config: {},
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const view = (id: string, tableId: string, deletedAt: string | null = null): View => ({
  id,
  tableId,
  name: id,
  description: null,
  icon: null,
  source: `from table {${tableId}}`,
  ui: {},
  ownerUserId: null,
  position: 0,
  deletedAt,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("query workspace model", () => {
  test("sanitizes UI current source for API requests", () => {
    expect(currentSourceForApi({ kind: "table", tableId: "table-id", label: "Orders", ref: "Orders" })).toEqual({
      kind: "table",
      tableId: "table-id",
    });
    expect(currentSourceForApi({ kind: "view", viewId: "view-id", label: "Open", ref: "Open" })).toEqual({
      kind: "view",
      viewId: "view-id",
    });
  });

  test("summarizes query text without treating empty input as zero-height", () => {
    expect(queryTextStats("")).toEqual({ chars: 0, lines: 1, nonEmptyLines: 0, clauses: 0 });
    expect(queryTextStats("from table Orders\nselect Amount; sort Amount desc")).toEqual({
      chars: 49,
      lines: 2,
      nonEmptyLines: 2,
      clauses: 3,
    });
  });

  test("summarizes preview states", () => {
    expect(previewSummary(null, false)).toMatchObject({ kind: "idle", label: "No result" });
    expect(previewSummary(null, true)).toMatchObject({ kind: "checking", label: "Checking" });
    expect(previewSummary({ ok: false, diagnostics: [{ message: "bad" }, { message: "worse" }] }, false)).toMatchObject({
      kind: "issues",
      diagnostics: 2,
    });

    const ready: PublicDslQueryPreviewResponse = {
      ok: true,
      mode: "groups",
      columns: [{ key: "total", label: "Total", type: "number", sqlType: "number" }],
      rows: [{ values: { total: 10 } }],
      truncated: true,
      limit: 1,
      explode: true,
    };
    expect(previewSummary(ready, false)).toMatchObject({
      kind: "ready",
      rows: 1,
      columns: 1,
      mode: "groups",
      truncated: true,
      explode: true,
      limit: 1,
    });
    expect(previewSummary(null, false, "de")).toMatchObject({ kind: "idle", label: "Kein Ergebnis" });
    expect(previewSummary(null, true, "de-CH")).toMatchObject({ kind: "checking", label: "Wird geprüft" });
    expect(previewSummary({ ok: false, diagnostics: [{ message: "bad" }] }, false, "de-CH")).toMatchObject({
      kind: "issues",
      label: "Probleme",
    });
    expect(previewSummary(ready, false, "de")).toMatchObject({ kind: "ready", label: "Bereit" });
  });

  test("counts only visible source catalog entries", () => {
    const active = table("active");
    const deleted = table("deleted", "2026-01-01T00:00:00.000Z");

    expect(visibleFields([field("name", active.id), field("old", active.id, "2026-01-01T00:00:00.000Z")]).map((item) => item.id)).toEqual([
      "name",
    ]);
    expect(visibleViews([view("open", active.id), view("old", active.id, "2026-01-01T00:00:00.000Z")]).map((item) => item.id)).toEqual([
      "open",
    ]);
    expect(
      sourceCatalogSummary(
        [active, deleted],
        { [active.id]: [field("name", active.id)], [deleted.id]: [field("secret", deleted.id)] },
        { [active.id]: [view("open", active.id)], [deleted.id]: [view("old", deleted.id)] },
      ),
    ).toEqual({ tables: 1, fields: 1, views: 1 });
  });

  test("shows matching fields before the default source field slice", () => {
    const fields = Array.from({ length: 10 }, (_, index) => field(index === 9 ? "invoice total" : `field-${index}`, "table"));
    expect(sourceFieldsForSearch(fields, "invoice")).toEqual({ shown: [fields[9]!], hidden: 0 });
    expect(sourceFieldsForSearch(fields, "table name")).toEqual({ shown: fields.slice(0, 8), hidden: 2 });
  });
});
