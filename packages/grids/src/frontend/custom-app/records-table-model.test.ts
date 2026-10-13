import { describe, expect, test } from "bun:test";
import { customAppRecordsResultColumns } from "./records-table-model";

const columns = [
  {
    key: "name",
    label: "Name",
    tableId: "TABLE1",
    fieldId: "FIELD1",
    type: "text",
    sqlType: "text",
  },
  { key: "total", label: "Total", type: "number", sqlType: "numeric", aggregate: "count" },
];

describe("App Records columns", () => {
  test("keeps every GQL output column, including aliases without field IDs", () => {
    expect(customAppRecordsResultColumns(columns).map((column) => column.key)).toEqual(["name", "total"]);
  });

  test("filters saved-view output to the explicitly selected fields", async () => {
    expect(customAppRecordsResultColumns(columns, ["FIELD1"]).map((column) => column.key)).toEqual(["name"]);
    expect(customAppRecordsResultColumns(columns, ["FIELD2"])).toEqual([]);
    const source = await Bun.file(new URL("./RecordsTable.tsx", import.meta.url)).text();
    expect(source).toContain("<Placeholder");
    expect(source).toContain('state="error"');
    expect(source).not.toContain("rounded-xl border");
  });
});
