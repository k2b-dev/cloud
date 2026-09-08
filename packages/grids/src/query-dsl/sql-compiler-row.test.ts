import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { resolveDslQueryToQueryPlan } from "./resolver";
import { ctx, field, normalizedSql, orders, parseOk } from "./resolver-fixtures";
import { compileDslQueryPlanToSql } from "./sql-compiler-row";

describe("editable record SQL selection", () => {
  test("retains the full persisted record without forcing JS-only formula fields through SQL", () => {
    const fields = [
      field({ id: "formula-id", shortId: "FORM01", name: "Formula", type: "formula", config: { expression: "UNSUPPORTED()" } }),
    ];
    const plan = { tableId: orders.id, query: {} };
    const compiled = compileDslQueryPlanToSql(plan, {
      fieldsByTableId: { [orders.id]: fields },
      recordProjection: sql`r.*`,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(compiled.error);
    expect(normalizedSql(compiled.query.sql)).toContain("SELECT r.*");
    expect(compiled.query.columns).toEqual([]);
    expect(compileDslQueryPlanToSql(plan, { fieldsByTableId: { [orders.id]: fields } }).ok).toBe(false);
  });

  test("uses the same predicates, parent liveness and ordering for records and query projections", () => {
    const context = ctx();
    const resolved = resolveDslQueryToQueryPlan(parseOk("from table Orders\nwhere amount > 3\nsort amount desc nulls first"), context);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("invalid fixture");
    const options = { fieldsByTableId: context.fieldsByTableId, limit: 11 };
    const rows = compileDslQueryPlanToSql(resolved.plan, options);
    const records = compileDslQueryPlanToSql(resolved.plan, { ...options, recordProjection: sql`r.*` });
    expect(rows.ok && records.ok).toBe(true);
    if (!rows.ok || !records.ok) throw new Error("invalid SQL fixture");
    const selectionTail = (query: unknown) => normalizedSql(query).split("FROM grids.records r").at(-1)!.replace(/\$\d+/g, "?");
    expect(selectionTail(records.query.sql)).toBe(selectionTail(rows.query.sql));
  });

  test("does not coerce joined or aggregate output into editable records", () => {
    const context = ctx();
    for (const source of [
      "from table Orders\njoin table Custs as c on customer_link = c.id",
      "from table Orders\naggregate count(*) as rows",
    ]) {
      const resolved = resolveDslQueryToQueryPlan(parseOk(source), context);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error("invalid fixture");
      expect(compileDslQueryPlanToSql(resolved.plan, { fieldsByTableId: context.fieldsByTableId, recordProjection: sql`r.*` }).ok).toBe(
        false,
      );
    }
  });
});
