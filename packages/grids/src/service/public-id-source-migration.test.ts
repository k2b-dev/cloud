import { expect, test } from "bun:test";
import { canonicalizeGqlSourceForPublicIdMigration, type PublicIdMigrationRow } from "./public-id-source-migration";
import type { Field } from "./types";

const tableId = "11111111-1111-4111-8111-111111111111";
const fieldId = "22222222-2222-4222-8222-222222222222";
const baseId = "33333333-3333-4333-8333-333333333333";
const rows: PublicIdMigrationRow[] = [
  { resource: "tables", id: tableId, parentId: baseId, oldShortId: "OLDT1", newShortId: "TABLE1" },
  { resource: "fields", id: fieldId, parentId: tableId, oldShortId: "OLDF1", newShortId: "FIELD1" },
];
const field: Field = {
  id: fieldId,
  shortId: "FIELD1",
  tableId,
  name: "Amount",
  description: null,
  icon: null,
  type: "number",
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
};
const context = {
  tables: [{ kind: "table" as const, id: tableId, shortId: "TABLE1", name: "Orders" }],
  fieldsByTableId: { [tableId]: [field] },
};

test("public-id migration rewrites bare and braced GQL refs before canonical validation", () => {
  expect(
    canonicalizeGqlSourceForPublicIdMigration({
      source: `from table OLDT1\nselect OLDF1\nwhere {${fieldId}} > 0`,
      rows,
      sourceScopes: [`tables:${baseId}`],
      fieldScopes: [`fields:${tableId}`],
      context,
    }),
  ).toBe("from table {TABLE1}\nselect {FIELD1}\nwhere {FIELD1} > 0");
});

test("public-id migration preserves document record Liquid placeholders", () => {
  expect(
    canonicalizeGqlSourceForPublicIdMigration({
      source: `from table OLDT1\nwhere record.id = '{{ record.id }}'\nselect OLDF1`,
      rows,
      sourceScopes: [`tables:${baseId}`],
      fieldScopes: [`fields:${tableId}`],
      context,
    }),
  ).toBe("from table {TABLE1}\nselect {FIELD1}\nwhere record.id = '{{ record.id }}'");
});

test("public-id migration preserves typed dynamic GQL context values", () => {
  expect(
    canonicalizeGqlSourceForPublicIdMigration({
      source:
        "from table OLDT1\nwhere record.id = @params.record_id and oneof(record.createdBy, @auth.subjects) and @time.today = @time.today",
      rows,
      sourceScopes: [`tables:${baseId}`],
      fieldScopes: [`fields:${tableId}`],
      context,
    }),
  ).toBe(
    "from table {TABLE1}\nwhere record.id = @params.record_id and oneof(record.createdBy, @auth.subjects) and @time.today = @time.today",
  );
});

test("public-id migration fails closed for unresolved UUID refs", () => {
  expect(() =>
    canonicalizeGqlSourceForPublicIdMigration({
      source: "from table {aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}",
      rows,
      sourceScopes: [`tables:${baseId}`],
      fieldScopes: [`fields:${tableId}`],
      context,
    }),
  ).toThrow("cannot migrate public reference");
});
