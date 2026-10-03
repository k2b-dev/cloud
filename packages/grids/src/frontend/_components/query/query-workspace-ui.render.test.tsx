import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PublicField as Field, PublicTable as Table } from "../../../api/public-dto";
import { formatIdentifierRef } from "../../../ref-syntax";
import { QUERY_PANEL_DIALOG_OPTIONS } from "../records-view/RecordsView";
import SearchBar from "../toolbar/SearchBar";
import QueryWorkspace from "./QueryWorkspace";

const table: Table = {
  id: "items",
  baseId: "inventory",
  name: "Items",
  description: null,
  icon: null,
  kind: "stored",
  columns: [],
  displayConfig: { mode: "table" },
  auditPolicy: {},
  mutationPolicy: { mode: "all" },
  position: 0,
  disableDirectInsert: false,
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  deletedAt: null,
};

const field: Field = {
  id: "name",
  tableId: table.id,
  name: "Name",
  description: null,
  icon: null,
  type: "text",
  required: false,
  presentable: true,
  hideInTable: false,
  position: 0,
  indexed: false,
  uniqueConstraint: false,
  defaultValue: null,
  config: {},
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  deletedAt: null,
};

const quotedField: Field = {
  ...field,
  id: "asset-id",
  name: "Asset ID",
};

describe("query workspace UI contracts", () => {
  test("keeps the fill editor tall and source fields compact without showing identifier quotes", () => {
    const html = renderToString(() =>
      createComponent(QueryWorkspace, {
        baseId: table.baseId,
        initialQuery: "",
        queryPath: "/app/grids/inventory/query",
        tables: [table],
        fieldsByTable: { [table.id]: [quotedField] },
        viewsByTable: {},
      }),
    );

    expect(html).toContain('class="k2b-field " data-fill="true"');
    expect(html).toContain('bg-surface p-2" data-scroll-preserve="grids-query-workspace"');
    expect(html).not.toContain('bg-[var(--ui-surface-subtle)] p-2" data-scroll-preserve="grids-query-workspace"');
    expect(html).toContain("text-[11px] leading-4");
    expect(html).toContain('<span class="truncate">Asset ID</span>');
    expect(html).not.toContain('<span class="truncate">&quot;Asset ID&quot;</span>');
    expect(html).toContain('<span class="text-dimmed">text</span>');
    expect(formatIdentifierRef(quotedField.name)).toBe('"Asset ID"');
  });

  test("shows query diagnostics as danger notices, not hand-coloured boxes", () => {
    const html = renderToString(() =>
      createComponent(QueryWorkspace, {
        baseId: table.baseId,
        initialQuery: "from Items select Price",
        initialPreview: {
          ok: false,
          diagnostics: [
            { code: "gql.resolution", line: 1, column: 19, message: "Unknown field Price" },
            { code: "gql.access", message: "You cannot read this table" },
          ],
        },
        queryPath: "/app/grids/inventory/query",
        tables: [table],
        fieldsByTable: { [table.id]: [field] },
        viewsByTable: {},
      }),
    );

    expect(html.match(/class="k2b-notice-card\s*" data-tone="danger"/g)).toHaveLength(2);
    expect(html).toContain('<p class="k2b-notice-card__title">Line 1 · Col 19</p>');
    expect(html).toContain('<p class="k2b-notice-card__description">Unknown field Price</p>');
    expect(html).toContain('<p class="k2b-notice-card__title">Query</p>');
    expect(html).not.toContain("bg-red-50");
    expect(html).not.toContain("uppercase");
  });

  test("uses the semantic wide panel dialog contract", () => {
    expect(QUERY_PANEL_DIALOG_OPTIONS.panelClassName).toContain("is-wide");
    expect(QUERY_PANEL_DIALOG_OPTIONS.panelClassName).not.toContain("w-[");
  });

  test("separates search scope labels from field types", () => {
    const html = renderToString(() =>
      createComponent(SearchBar, {
        fields: [field],
        initialQ: "",
        initialQFields: [],
        onSearchChange: () => undefined,
      }),
    );

    expect(html).toContain('<strong class="truncate">Name</strong>');
    expect(html).toContain('<small class="shrink-0 text-dimmed">text</small>');
  });
});
