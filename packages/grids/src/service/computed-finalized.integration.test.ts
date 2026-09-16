import { beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest } from "../integration-test-utils";
import { migrate } from "../migrate";
import { field } from "../query-dsl/sql-compiler.integration-fixtures";
import { normalizedSqlParts } from "../sql-test-utils";
import { buildComputedFieldSqlMap } from "./computed-projections";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

postgresTest("finalized projections omit live list plans while retaining capture and provenance checks", async () => {
  const items = field({
    id: "items",
    tableId: "source",
    shortId: "Items1",
    name: "Items",
    type: "object_list",
    config: { fields: [{ id: "Amount", name: "Amount", type: "number" }] },
  });
  const total = field({
    id: "total",
    tableId: "source",
    shortId: "Total1",
    name: "Total",
    type: "formula",
    config: { expression: "LIST_SUM(Items, 'Amount')" },
  });
  const fields = [items, total];
  for (const finalizedOnly of [false, true]) {
    const map = await buildComputedFieldSqlMap(fields, {
      finalizedOnly,
      requireCapturedValues: true,
      authorizedTableIds: new Set(["source"]),
    });
    const expression = map.get(total.id)!;
    const text = normalizedSqlParts(sql`SELECT ${expression.sql}`).text;
    expect(text.includes("jsonb_array_elements")).toBe(!finalizedOnly);
    const read = async (finalized: boolean, captured: boolean, dependencies: string[]) => {
      const [row] = await sql`SELECT (${expression.sql})::text AS value FROM (
        SELECT ${{ items: [{ Amount: "999" }], total: "12.34" }}::jsonb AS data,
          ${finalized ? "2026-01-01" : null}::timestamptz AS finalized_at,
          ${captured ? { total: "numeric" } : {}}::jsonb AS finalized_computed_types,
          ${{ total: dependencies }}::jsonb AS finalized_computed_dependencies
        OFFSET 0
      ) r`;
      return row.value;
    };
    expect(await read(true, true, ["source"])).toBe("12.34");
    expect(await read(true, true, ["source", "denied"])).toBeNull();
    expect(await read(false, false, [])).toBe(finalizedOnly ? null : "999");
    await expect(read(true, false, ["source"])).rejects.toThrow("missing captured calculation");
  }
  // Combined tables must still calculate their own formulas over projected data.
  const virtual = await buildComputedFieldSqlMap(fields, { finalizedOnly: true, useFinalizedFormulaValues: false });
  expect(normalizedSqlParts(sql`SELECT ${virtual.get(total.id)!.sql}`).text).toContain("jsonb_array_elements");
});
