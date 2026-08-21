import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import type { Field } from "../service/types";
import { resolveDslQueryToQueryPlan, resolveDslQueryToRecordQuery } from "./resolver";
import { ctx, customerLinkFieldId, customerScoreFieldId, field, fields, normalizedSql, orders, parseOk } from "./resolver-fixtures";
import { compileDslAggregateQueryPlanToSql, compileDslGroupedQueryPlanToSql, compileDslQueryPlanToSql } from "./sql-compiler";

describe("GQL lookup/rollup fields (C3)", () => {
  const marginId = "ffffffff-ffff-4fff-8fff-fffffffffff5";
  const customerScoreLookupId = "ffffffff-ffff-4fff-8fff-fffffffffff6";
  const totalId = "ffffffff-ffff-4fff-8fff-fffffffffff7";
  const withRollup: Field[] = [
    ...fields,
    field({
      id: marginId,
      shortId: "margin",
      name: "Margin",
      type: "formula",
      position: 8,
      config: { expression: "amount - cost" },
    }),
    field({
      id: customerScoreLookupId,
      shortId: "customer_score",
      name: "Customer score lookup",
      type: "lookup",
      position: 9,
      config: { relationFieldId: customerLinkFieldId, targetFieldId: customerScoreFieldId },
    }),
    field({
      id: totalId,
      shortId: "total",
      name: "Total",
      type: "rollup",
      position: 10,
      config: { relationFieldId: customerLinkFieldId, agg: "count" },
    }),
  ];
  const rollupCtx = () => ctx({ fieldsByTableId: { ...ctx().fieldsByTableId, [orders.id]: withRollup } });
  // The compiler is handed pre-built lookup/rollup SQL (built async + cross-table
  // in preview); here we inject a stand-in so the unit test stays DB-free.
  const computedFieldSql = new Map([
    [customerScoreLookupId, { sql: sql`(SELECT 3)`, type: "numeric" as const }],
    [totalId, { sql: sql`(SELECT 7)`, type: "numeric" as const }],
  ]);
  const planOf = (source: string) => {
    const resolved = resolveDslQueryToQueryPlan(parseOk(source), rollupCtx());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.diagnostics.map((d) => d.message).join("; "));
    return resolved.plan;
  };

  test("a rollup field is selectable and compiles to its injected SQL", () => {
    const compiled = compileDslQueryPlanToSql(planOf(`select amount, total`), {
      fieldsByTableId: rollupCtx().fieldsByTableId,
      computedFieldSql,
    });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.query.columns.map((c) => c.label)).toEqual(["Amount", "Total"]);
      expect(normalizedSql(compiled.query.sql)).toContain("(SELECT 7) AS q_col_1");
    }
  });

  test("without the computed map a rollup field is reported unavailable", () => {
    const compiled = compileDslQueryPlanToSql(planOf(`select total`), { fieldsByTableId: rollupCtx().fieldsByTableId });
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.error).toContain("not available");
  });

  test("a rollup field can be filtered and sorted via the injected SQL", () => {
    const whereSql = compileDslQueryPlanToSql(planOf(`where total > 0`), {
      fieldsByTableId: rollupCtx().fieldsByTableId,
      computedFieldSql,
    });
    expect(whereSql.ok).toBe(true);
    if (whereSql.ok) expect(normalizedSql(whereSql.query.sql)).toContain("((SELECT 7))::numeric >");

    const sortSql = compileDslQueryPlanToSql(planOf(`select amount\nsort total desc`), {
      fieldsByTableId: rollupCtx().fieldsByTableId,
      computedFieldSql,
    });
    expect(sortSql.ok).toBe(true);
    if (sortSql.ok) expect(normalizedSql(sortSql.query.sql)).toContain("ORDER BY (SELECT 7) DESC");
  });

  test("a rollup field can be used inside aggregate-only formula aggregates", () => {
    const compiled = compileDslAggregateQueryPlanToSql(planOf(`aggregate sum(formula(total + 1)) as adjusted_total`), {
      fieldsByTableId: rollupCtx().fieldsByTableId,
      computedFieldSql,
    });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      const text = normalizedSql(compiled.query.sql);
      expect(text).toContain("(SELECT 7)");
      expect(compiled.query.columns.map((column) => column.key)).toContain("adjusted_total__sum");
    }
  });

  test("a rollup field can be aggregated directly via the injected SQL", () => {
    const compiled = compileDslAggregateQueryPlanToSql(planOf(`aggregate sum(total) as direct_total`), {
      fieldsByTableId: rollupCtx().fieldsByTableId,
      computedFieldSql,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const text = normalizedSql(compiled.query.sql);
    expect(text).toContain("(SELECT 7)");
    expect(compiled.query.columns.map((column) => column.key)).toEqual(["direct_total__sum"]);
  });

  test("a grouped rollup field can be aggregated directly via the injected SQL", () => {
    const compiled = compileDslGroupedQueryPlanToSql(
      planOf(`group by status\naggregate sum(total) as direct_total\nsort direct_total desc`),
      {
        fieldsByTableId: rollupCtx().fieldsByTableId,
        computedFieldSql,
      },
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const text = normalizedSql(compiled.query.sql);
    expect(text).toContain("(SELECT 7)");
    expect(text).toContain("direct_total__sum");
  });

  test("formula, lookup, and rollup fields can be base group keys in SQL-only GQL plans", () => {
    const plan = planOf(`
      group by margin, customer_score, total
      aggregate count(*) as rows
      sort customer_score desc nulls last
    `);
    expect(plan.query.groupBy).toBeUndefined();
    expect(plan.sqlGroupBy).toEqual([
      { fieldId: marginId, tableId: orders.id, label: "Margin" },
      { fieldId: customerScoreLookupId, tableId: orders.id, label: "Customer score lookup", direction: "desc", nullsFirst: false },
      { fieldId: totalId, tableId: orders.id, label: "Total" },
    ]);

    const compiled = compileDslGroupedQueryPlanToSql(plan, {
      fieldsByTableId: rollupCtx().fieldsByTableId,
      computedFieldSql,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const text = normalizedSql(compiled.query.sql);
    expect(text).toContain("grids.canonical_numeric(r.data->>");
    expect(text).toContain("(SELECT 3) AS gk_1");
    expect(text).toContain("(SELECT 7) AS gk_2");
    expect(text).toContain('ORDER BY "gk_0" ASC NULLS LAST');
    expect(text).toContain('"gk_1" DESC NULLS LAST');
    expect(text).toContain('"gk_2" ASC NULLS LAST');
  });

  test("base computed group keys stay out of RecordQuery runtime", () => {
    const result = resolveDslQueryToRecordQuery(parseOk(`group by total\naggregate count(*) as rows`), rollupCtx());
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics.map((d) => d.message)).toEqual([
        "group by computed fields cannot be represented by the records-table runtime yet",
      ]);
  });

  test("direct rollup aggregate aliases resolve case-insensitively in having", () => {
    const compiled = compileDslGroupedQueryPlanToSql(
      planOf(`group by status\naggregate sum(total) as Direct_Total\nhaving direct_total > 0`),
      {
        fieldsByTableId: rollupCtx().fieldsByTableId,
        computedFieldSql,
      },
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const text = normalizedSql(compiled.query.sql);
    expect(text).toContain("(SELECT 7)");
    expect(text).toContain("Direct_Total__sum");
    expect(text).toContain("HAVING");
  });

  test("direct rollup aggregates fail loudly without compatible computed SQL", () => {
    const missing = compileDslAggregateQueryPlanToSql(planOf(`aggregate sum(total) as direct_total`), {
      fieldsByTableId: rollupCtx().fieldsByTableId,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("cannot be compiled into SQL formulas yet");

    const textSql = new Map([[totalId, { sql: sql`(SELECT 'x')`, type: "text" as const }]]);
    const incompatible = compileDslAggregateQueryPlanToSql(planOf(`aggregate sum(total) as direct_total`), {
      fieldsByTableId: rollupCtx().fieldsByTableId,
      computedFieldSql: textSql,
    });
    expect(incompatible.ok).toBe(false);
    if (!incompatible.ok) expect(incompatible.error).toContain('agg "sum" not compatible with SQL type "text"');
  });

  test("a rollup field can be used inside grouped formula aggregates", () => {
    const compiled = compileDslGroupedQueryPlanToSql(planOf(`group by status\naggregate sum(formula(total + 1)) as adjusted_total`), {
      fieldsByTableId: rollupCtx().fieldsByTableId,
      computedFieldSql,
    });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      const text = normalizedSql(compiled.query.sql);
      expect(text).toContain("(SELECT 7)");
      expect(text).toContain("adjusted_total__sum");
    }
  });
});
