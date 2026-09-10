import { test, expect } from "bun:test";
import { safeQuery } from "../src/database-sql";
import { importData } from "../src/database-import";
import type { DatabaseRequest } from "../src/database-contracts";
test("Kit SELECT subset rejects internal objects, external functions and write syntax", () => {
  for (const sql of [
    "SELECT * FROM _meta",
    'SELECT * FROM "_meta"',
    "SELECT * FROM [_meta]",
    "SELECT * FROM sqlite_master",
    "SELECT * FROM pragma_table_info('x')",
    "SELECT load_extension(?)",
    "SELECT readfile(?)",
    "SELECT unknown_function(1)",
    "SELECT 1; DELETE FROM x",
    "SELECT 1 -- comment",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "DELETE FROM x",
    "SELECT * FROM x /*a*/",
    "SELECT * FROM main.sqlite_schema",
  ])
    expect(() => safeQuery(sql)).toThrow();
  expect(safeQuery("SELECT nummer, SUM(betrag) AS total FROM belege WHERE status = ? GROUP BY nummer")).toContain("LIMIT 1001");
  expect(safeQuery("SELECT a.id FROM belege a JOIN users b ON a.user_id = b.id WHERE b.name = 'O''Brien'")).toContain("JOIN");
});
test("imports prevalidate all rows before creating or writing and preserve text IDs", async () => {
  const calls: DatabaseRequest[] = [];
  const execute = async (req: DatabaseRequest) => {
    calls.push(req);
    return req.operation === "tables.list" ? [] : {};
  };
  await expect(
    importData(
      "items",
      [
        { key: "001", amount: 1 },
        { key: "002", amount: "bad" },
      ],
      { createTable: true },
      execute,
    ),
  ).rejects.toThrow("DB_IMPORT_INVALID");
  expect(calls).toHaveLength(0);
  const result = await importData(
    "items",
    [
      { key: "001", amount: 1 },
      { key: "002", amount: 2 },
    ],
    { createTable: true },
    execute,
  );
  expect(result).toMatchObject({ confirmedRows: 2, status: "complete" });
  expect(calls.find((c) => c.operation === "tables.create")).toMatchObject({
    columns: [
      { name: "key", type: "text" },
      { name: "amount", type: "integer" },
    ],
  });
});
test("import never replays a write whose response was lost and reports only confirmed batches", async () => {
  let writes = 0;
  const progress: number[] = [];
  const result = await importData(
    "items",
    Array.from({ length: 1002 }, (_, i) => ({ value: i })),
    { createTable: true },
    async (req) => {
      if (req.operation === "tables.list") return [];
      if (req.operation === "rows.insert" && ++writes === 2) throw new Error("response lost after commit");
      return {};
    },
    (p) => progress.push(p.confirmedRows),
  );
  expect(writes).toBe(2);
  expect(result).toMatchObject({ status: "unknown", confirmedRows: 1000, totalRows: 1002 });
  expect(progress.at(-1)).toBe(1000);
});
test("cancel stops future batches without undoing confirmed writes", async () => {
  const abort = new AbortController();
  let writes = 0;
  const result = await importData(
    "items",
    Array.from({ length: 1001 }, (_, i) => ({ value: i })),
    { createTable: true },
    async (req) => {
      if (req.operation === "tables.list") return [];
      if (req.operation === "rows.insert") writes++;
      return {};
    },
    (p) => {
      if (p.confirmedRows) abort.abort();
    },
    abort.signal,
  );
  expect(writes).toBe(1);
  expect(result).toMatchObject({ status: "cancelled", confirmedRows: 1000 });
});
