import { beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { parseGridsQueryDsl } from "./parser";
import { resolveDslQueryToQueryPlan } from "./resolver";
import { compileDslAggregateQueryPlanToSql, compileDslGroupedQueryPlanToSql, compileDslQueryPlanToSql } from "./sql-compiler";
import { cleanupFixture, ctx, insertDslDbFixture, postgresTest } from "./sql-compiler.integration-fixtures";

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

postgresTest("compiled row, aggregate, grouped and saved-view queries recheck parent liveness in every trash mode", async () => {
  const fixture = await insertDslDbFixture();
  try {
    const options = { fieldsByTableId: fixture.fieldsByTableId };
    const compile = (source: string, view = false) => {
      const parsed = parseGridsQueryDsl(source);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
      const resolved = resolveDslQueryToQueryPlan(parsed.ast, ctx(fixture));
      if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
      const plan = view ? { ...resolved.plan, viewSourceQuery: { ...resolved.plan.query, limit: 1 } } : resolved.plan;
      const aggregate = (plan.query.aggregations?.length ?? 0) > 0 && !plan.query.groupBy?.length;
      const compiled = plan.query.groupBy?.length
        ? compileDslGroupedQueryPlanToSql(plan, options)
        : aggregate
          ? compileDslAggregateQueryPlanToSql(plan, options)
          : compileDslQueryPlanToSql(plan, options);
      if (!compiled.ok) throw new Error(compiled.error);
      return { query: compiled.query.sql, aggregate };
    };
    const queries = ["", "\ninclude deleted", "\ndeleted only"].flatMap((mode) => [
      compile(`from table Orders\nselect Amount${mode}`),
      compile(`from table Orders\nselect Amount${mode}`, true),
      compile(`from table Orders\naggregate count(*) as total${mode}`),
      compile(`from table Orders\ngroup by Status\naggregate count(*) as total${mode}`),
    ]);
    for (const { query } of queries) expect((await sql`${query}`).length).toBeGreaterThan(0);
    const assertUnavailable = async () => {
      for (const { query, aggregate } of queries) {
        const rows = await sql`${query}`;
        if (aggregate) expect(Object.values(rows[0].result)).toEqual([0]);
        else expect(rows).toHaveLength(0);
      }
    };
    await sql`UPDATE grids.tables SET deleted_at = now() WHERE id = ${fixture.orders.id}::uuid`;
    await assertUnavailable();
    await sql`UPDATE grids.tables SET deleted_at = NULL WHERE id = ${fixture.orders.id}::uuid`;
    await sql`UPDATE grids.bases SET deleted_at = now() WHERE id = ${fixture.baseId}::uuid`;
    await assertUnavailable();
  } finally {
    await cleanupFixture(fixture.baseId);
  }
});
