import { expect, test } from "bun:test";
import { field } from "../table/database-table.fixture-data";
import { recordFieldRows } from "./record-field-rows";

const ids = (rows: { id: string }[][]) => rows.map((row) => row.map((entry) => entry.id));

test("one-line values pair up in field order; the name, long text, links, and many-valued choices stand alone", () => {
  const rows = recordFieldRows([
    field({ id: "name", name: "Name", type: "text", presentable: true }),
    field({ id: "kind", name: "Kind", type: "select", config: { options: [] } }),
    field({ id: "place", name: "Place", type: "select", config: { options: [] } }),
    field({ id: "count", name: "Count", type: "number" }),
    field({ id: "note", name: "Note", type: "longtext" }),
    field({ id: "price", name: "Price", type: "number" }),
    field({ id: "tags", name: "Tags", type: "select", config: { multiple: true, options: [] } }),
    field({ id: "due", name: "Due", type: "date" }),
    field({ id: "owner", name: "Owner", type: "principal", config: { cardinality: "single" } }),
  ]);
  expect(ids(rows)).toEqual([["name"], ["kind", "place"], ["count"], ["note"], ["price"], ["tags"], ["due", "owner"]]);
});
