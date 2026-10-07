import { expect, test } from "bun:test";
import { DatabaseRequest, DbColumn } from "./database-contracts";
import { boundedRows, checkColumns, checkRowWrite, FlatDatabaseRequest, listRows, listSql, tableWrite, typedRow } from "./database-runtime";

const schema = {
  columns: [
    { name: "id", type: "integer" },
    { name: "done", type: "boolean" },
    { name: "data", type: "json" },
    { name: "created_by", type: "text" },
  ],
};
test("flat list uses equality and IS NULL with validated ordering", () => {
  const req = FlatDatabaseRequest.parse({
    operation: "list",
    table: "tasks",
    where: { done: false, created_by: null },
    order: "-id",
    offset: 2,
  });
  if (req.operation !== "list") throw new Error("wrong request");
  expect(listSql(req, schema)).toEqual({
    sql: 'SELECT "id" FROM "tasks" WHERE "done" = ? AND "created_by" IS NULL ORDER BY "id" DESC LIMIT 1001 OFFSET 2',
    params: [0],
  });
  expect(() => listSql({ ...req, where: { missing: "x" } }, schema)).toThrow("existing columns: id, done, data, created_by");
  expect(() => listSql({ ...req, order: "id; DROP TABLE tasks" }, schema)).toThrow("Use order");
  expect(FlatDatabaseRequest.safeParse({ operation: "tables.create", name: "x", columns: [] }).success).toBe(false);
});
test("booleans and JSON are typed; more than 1000 rows fails rather than truncating", () => {
  expect(typedRow({ id: 1, done: 0, data: '{"x":true}', created_by: null }, schema)).toEqual({
    id: 1,
    done: false,
    data: { x: true },
    created_by: null,
  });
  expect(() => boundedRows(Array.from({ length: 1001 }, () => ({ id: 1 })))).toThrow("limit and offset");
  expect(boundedRows([])).toEqual([]);
});
test("list preserves SQL ordering and obtains logical types when rsql schema reports physical types", async () => {
  const physicalSchema = {
    columns: [
      { name: "id", type: "integer" },
      { name: "done", type: "integer" },
      { name: "data", type: "text" },
    ],
  };
  const request = { operation: "list" as const, table: "tasks", where: {}, order: "-id", offset: 0 };
  const raw = [
    { id: 2, done: 1, data: '{"a":1}' },
    { id: 1, done: 0, data: null },
  ];
  expect(typedRow(raw[0]!, physicalSchema)).toEqual(raw[0]!);
  const rows = await listRows(
    request,
    physicalSchema,
    async () => ({ data: raw }),
    async (query) => {
      expect(query).toEqual({ id: "in.(2,1)", limit: 2 });
      return {
        data: [
          { id: 1, done: false, data: null },
          { id: 2, done: true, data: { a: 1 } },
        ],
      };
    },
  );
  expect(rows).toEqual([
    { id: 2, done: true, data: { a: 1 } },
    { id: 1, done: false, data: null },
  ]);
});
test("list bounds the selection before fetching typed rows and skips empty selections", async () => {
  const request = { operation: "list" as const, table: "tasks", where: {}, offset: 0 };
  const unexpected = async () => {
    throw new Error("No row fetch expected");
  };
  expect(await listRows(request, schema, async () => ({ data: null }), unexpected)).toEqual([]);
  await expect(
    listRows(request, schema, async () => ({ data: Array.from({ length: 1001 }, (_, id) => ({ id: id + 1 })) }), unexpected),
  ).rejects.toMatchObject({ code: "limit" });
  expect(
    await listRows(
      request,
      schema,
      async () => ({ data: [{ id: 1 }, { id: 2 }] }),
      async () => ({ data: [{ id: 2 }] }),
    ),
  ).toEqual([{ id: 2 }]);
});
test("audit columns are managed and table definitions expose a durable write rule", () => {
  expect(tableWrite(schema)).toBe("everyone");
  expect(tableWrite({ ...schema, metadata: { write: "own" } })).toBe("own");
  expect(
    DatabaseRequest.parse({ operation: "tables.create", name: "tasks", columns: [{ name: "title", type: "text" }], write: "managers" }),
  ).toMatchObject({ write: "managers" });
  for (const name of ["id", "created_at", "updated_at", "created_by", "updated_by"])
    expect(DbColumn.safeParse({ name, type: "text" }).success).toBe(false);
  expect(() => checkColumns(schema, ["created_by"], true)).toThrow("Cloud manages created_by");
});
test("all write rules deny anonymous and enforce creator or Manage permission", () => {
  for (const rule of ["everyone", "own", "managers"] as const)
    expect(() => checkRowWrite(rule, null, true, "insert")).toThrow("permission");
  expect(() => checkRowWrite("everyone", "one", false, "update", { created_by: "two" })).not.toThrow();
  expect(() => checkRowWrite("own", "one", false, "insert")).not.toThrow();
  expect(() => checkRowWrite("own", "one", false, "update", { created_by: "one" })).not.toThrow();
  expect(() => checkRowWrite("own", "one", true, "delete", { created_by: "two" })).toThrow("permission");
  expect(() => checkRowWrite("managers", "one", false, "insert")).toThrow("permission");
  expect(() => checkRowWrite("managers", "one", true, "insert")).not.toThrow();
});
