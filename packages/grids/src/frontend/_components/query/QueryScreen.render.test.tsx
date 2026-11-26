import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";
import type { PublicField as Field, PublicTable as Table } from "../../../api/public-dto";

const { default: QueryScreen } = await import("./QueryScreen");
const { testFrame } = await import("../records-view/records-frame.test-fixture");

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

const render = (overrides: Partial<Parameters<typeof QueryScreen>[0]> = {}) =>
  renderToString(() =>
    createComponent(QueryScreen, {
      frame: testFrame(),
      baseId: table.baseId,
      initialQuery: "",
      queryPath: "/app/grids/inventory/query",
      tables: [table],
      fieldsByTable: { [table.id]: [quotedField] },
      viewsByTable: {},
      ...overrides,
    }),
  );

describe("query screen on v2", () => {
  test("puts the editor in a drawing beside the sources, with one deed to save", () => {
    const html = render();
    expect(html).toContain('data-k2-part="Pane.Split"');
    expect(html).toContain('aria-label="GQL query"');
    expect(html).toContain('data-k2-part="Canvas"');
    // a source names its fields by count; the field names wait in its menu
    expect(html).toContain(">Items<");
    expect(html).toContain("1 field");
    expect(html).toContain("Save as view");
    expect(html).toContain("Write a query to see its rows");
    expect(html).not.toContain("data-k2b-panes");
  });

  test("states each diagnostic once as a notice, with its line and column", () => {
    const html = render({
      initialQuery: "from Items select Price",
      initialPreview: {
        ok: false,
        diagnostics: [
          { code: "gql.resolution", line: 1, column: 19, message: "Unknown field Price" },
          { code: "gql.access", message: "You cannot read this table" },
        ],
      },
    });
    expect(html.match(/data-k2-part="Notice"/g)).toHaveLength(2);
    expect(html).toContain("Line 1 · Col 19");
    expect(html.split("Unknown field Price")).toHaveLength(2);
  });

  test("shows the result rows on the server, with their range in the status row", () => {
    const html = render({
      initialQuery: "from Items",
      initialPreview: {
        ok: true,
        mode: "rows",
        limit: 100,
        columns: [{ key: "name", label: "Asset ID", type: "text", sqlType: "text", tableId: table.id, fieldId: quotedField.id }],
        rows: [{ recordId: "R1", values: { name: "Laptop 14" } }],
        truncated: false,
        page: { size: 100, start: 0, returned: 1, nextCursor: null },
      },
    });
    expect(html).toContain("Rows 1-1 · 1 column");
    expect(html).toContain("Laptop 14");
  });
});
