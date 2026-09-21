import { beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest } from "../integration-test-utils";
import { migrate } from "../migrate";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { dslQueryCalculationFieldIds } from "../query-dsl/plan-dependencies";
import { resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import { compileDslQueryPlanToSql } from "../query-dsl/sql-compiler";
import { compileBaseFieldColumn } from "../query-dsl/sql-compiler-fields";
import { buildComputedFieldSqlMap } from "../service/computed-projections";
import { lockDurableHistoryMutationBoundary } from "../service/durable-history";
import { listByTable } from "../service/field-read";
import { requireValidCalculationSql } from "../service/formula-sql-values";
import { compileLocalCalculationStorage } from "../service/local-calculation-storage";
import { finalize } from "../service/record-finalization";
import { get } from "../service/record-read";
import { instantiateDefinition } from "../service/templates";
import { normalizedSqlParts } from "../sql-test-utils";
import { billingAmountFields, billingLineConfig } from "./billing-lines";
import type { GridTemplate } from "./types";

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

postgresTest("billing full GQL projection reuses compiled roots and preserves live errors and frozen amounts", async () => {
  const definitions = billingAmountFields("bills", "en");
  const template: GridTemplate = {
    id: "billing-projection-test",
    name: "Billing projection",
    description: "Test",
    highlights: ["Test", "Test", "Test"],
    icon: "ti ti-receipt",
    baseName: `Billing projection ${Bun.randomUUIDv7()}`,
    tables: [{ key: "bills", name: "Bills", finalization: { mode: "direct" }, fields: definitions }],
    records: [
      {
        key: "bill",
        table: "bills",
        required: true,
        values: {
          positions: [
            { Label1: "A", Unit01: ["C62"], Qty001: "1", Price1: "0.03", Vat001: ["vat019"] },
            { Label1: "B", Unit01: ["C62"], Qty001: "1", Price1: "0.03", Vat001: ["vat019"] },
            { Label1: "C", Unit01: ["C62"], Qty001: "2.5", Price1: "10.01", Vat001: ["vat007"] },
          ],
        },
      },
    ],
  };
  const created = await instantiateDefinition(template, { withSampleData: false }, null, "en");
  if (!created.ok) throw new Error(created.error.message);
  const baseId = created.data.id;
  try {
    const [row] = await sql<Array<{ id: string; short_id: string; table_id: string; table_short_id: string }>>`
      SELECT r.id::text, r.short_id, r.table_id::text, t.short_id AS table_short_id
      FROM grids.records r JOIN grids.tables t ON t.id = r.table_id WHERE t.base_id = ${baseId}::uuid`;
    if (!row) throw new Error("Missing billing projection fixture");
    const fields = await listByTable(row.table_id);
    const fieldFor = (key: string) => {
      const definition = definitions.find((field) => field.key === key);
      const field = fields.find((field) => field.name === definition?.name);
      if (!field) throw new Error(`Missing billing field ${key}`);
      return field;
    };
    const positions = fieldFor("positions");
    const compile = async (selection = "") => {
      const current = await listByTable(row.table_id);
      const context = {
        tables: [{ id: row.table_id, shortId: row.table_short_id, name: "Bills", kind: "table" as const }],
        fieldsByTableId: { [row.table_id]: current },
      };
      const parsed = parseGridsQueryDsl(
        `from table {${row.table_short_id}} as bill\n${selection}\nwhere record.id = '${row.short_id}'\nlimit 1`,
      );
      if (!parsed.ok) throw new Error("Invalid projection source");
      const resolved = resolveDslQueryToQueryPlan(parsed.ast, context);
      if (!resolved.ok) throw new Error("Invalid projection plan");
      const computedFieldSql = await buildComputedFieldSqlMap(current, {
        fieldsByTableId: context.fieldsByTableId,
        fieldIds: dslQueryCalculationFieldIds(resolved.plan, context.fieldsByTableId),
        requireCapturedValues: true,
        useStoredLocalValues: true,
        authorizedTableIds: new Set([row.table_id]),
      });
      // Compare each actual projection to the existing typed root, not a fragile
      // PostgreSQL plan-node limit. Any extra value/error plan wrapper fails this.
      for (const [index, field] of current.entries()) {
        if (field.type !== "formula") continue;
        const root = computedFieldSql.get(field.id);
        if (!root) continue;
        const column = compileBaseFieldColumn({ field, fields: current, recordAlias: "r", index, tableId: row.table_id, computedFieldSql });
        if (!column.ok) throw new Error(column.error);
        expect(normalizedSqlParts(sql`SELECT ${column.projection}`)).toEqual(
          normalizedSqlParts(sql`SELECT ${requireValidCalculationSql(root)}`),
        );
      }
      const compiled = compileDslQueryPlanToSql(resolved.plan, { fieldsByTableId: context.fieldsByTableId, computedFieldSql });
      if (!compiled.ok) throw new Error(compiled.error);
      expect(compiled.query.columns).toHaveLength(selection ? 1 : 6);
      return compiled.query;
    };
    const grossQuery = await compile(`select {${fieldFor("gross").shortId}}`);
    const grossSql = normalizedSqlParts(grossQuery.sql);
    // The stored total is one JSON lookup with historical/error guards. Reading
    // it must never reconstruct positions or inline its transitive formulas.
    expect(grossSql.text.length).toBeLessThan(10_000);
    expect(grossSql.values.length).toBeLessThan(100);
    expect(grossSql.text).not.toContain("jsonb_array_elements(");
    expect(grossSql.text).toContain("current_local_calculations");
    const refreshDraft = async () => {
      await sql.begin(async (tx) => {
        await lockDurableHistoryMutationBoundary(tx, row.table_id);
        const current = await listByTable(row.table_id, false, tx);
        const values = compileLocalCalculationStorage(current);
        await tx`UPDATE grids.records r SET local_calculations = ${values}
          WHERE r.id = ${row.id}::uuid AND r.finalized_at IS NULL`;
      });
    };
    const readProjection = async () => {
      const query = await compile();
      const [record] = await sql<Array<Record<string, unknown>>>`${query.sql}`;
      if (!record) throw new Error("Missing projected row");
      return Object.fromEntries(query.columns.map((column) => [column.fieldId, record[column.key]]));
    };
    const record = await get(row.table_id, row.id);
    if (!record) throw new Error("Missing record read");
    expect(record.fieldErrors ?? {}).toEqual({});
    const live = await readProjection();
    expect(live[positions.id]).toEqual(record.data[positions.id]);
    for (const [key, amount] of Object.entries({ net7: "25.03", net19: "0.06", net: "25.09", tax: "1.76", gross: "26.85" })) {
      expect(String(live[fieldFor(key).id])).toBe(amount);
      expect(String(live[fieldFor(key).id])).toBe(String(record.data[fieldFor(key).id]));
    }
    // A malformed live cell must fail the complete projection, not disappear
    // from LIST_SUM or silently produce a valid-looking partial total.
    await sql`UPDATE grids.records SET data = jsonb_set(data, ${`{${positions.id}}`}::text[],
      ${[{ Label1: "Invalid", Unit01: ["C62"], Qty001: "not-a-number", Price1: "1", Vat001: ["vat019"] }]}::jsonb)
      WHERE id = ${row.id}::uuid`;
    await refreshDraft();
    await expect(readProjection()).rejects.toThrow("grids: invalid calculation");
    await sql`UPDATE grids.records SET data = ${record.data}::jsonb WHERE id = ${row.id}::uuid`;
    await refreshDraft();
    const frozen = await finalize({ tableId: row.table_id, recordId: row.id, actorId: null, origin: "direct" });
    if (!frozen.ok) throw new Error(frozen.error.message);
    expect(await readProjection()).toEqual(live);
    // New failing live formulas must not execute for the already frozen row.
    await sql`UPDATE grids.fields SET config = ${{ ...fieldFor("gross").config, expression: "1 / 0" }}::jsonb
      WHERE id = ${fieldFor("gross").id}::uuid`;
    const changedList = billingLineConfig("en");
    changedList.fields = changedList.fields.map((column) =>
      column.id === "Net001" ? { ...column, formula: { expression: "1 / 0" } } : column,
    );
    await sql`UPDATE grids.fields SET config = ${changedList}::jsonb WHERE id = ${positions.id}::uuid`;
    expect(await readProjection()).toEqual(live);
  } finally {
    await sql`UPDATE grids.records SET finalized_at = NULL, finalized_by = NULL, final_revision_id = NULL WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
    await sql`DELETE FROM grids.record_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
    await sql`DELETE FROM grids.table_finalization_activations WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
    await sql`DELETE FROM grids.durable_history_activations WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
    await sql`DELETE FROM grids.table_schema_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
    await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  }
});
