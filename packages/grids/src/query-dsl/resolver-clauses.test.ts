import { describe, expect, test } from "bun:test";
import { parseGridsQueryDsl } from "./parser";
import { resolveDslQueryToQueryPlan, resolveDslQueryToRecordQuery } from "./resolver";
import {
  amountFieldId,
  cities,
  countries,
  ctx,
  customerFieldId,
  customerNameFieldId,
  customers,
  normalizedSql,
  orderedAtFieldId,
  orders,
  parseOk,
  regions,
  statusFieldId,
} from "./resolver-fixtures";
import { compileDslGroupedQueryPlanToSql, compileDslQueryPlanToSql } from "./sql-compiler";

describe("GQL clauses: nulls, trash, grouped median/earliest/latest", () => {
  const planOf = (source: string) => {
    const resolved = resolveDslQueryToQueryPlan(parseOk(source), ctx());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.diagnostics.map((d) => d.message).join("; "));
    return resolved.plan;
  };
  const rowSqlOf = (source: string) => {
    const compiled = compileDslQueryPlanToSql(planOf(source), { fieldsByTableId: ctx().fieldsByTableId });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(compiled.error);
    return normalizedSql(compiled.query.sql);
  };

  test("sort accepts nulls first / nulls last modifiers", () => {
    expect(planOf(`sort amount asc nulls first`).query.sort).toEqual([{ fieldId: amountFieldId, direction: "asc", nullsFirst: true }]);
    expect(planOf(`sort amount desc nulls last`).query.sort).toEqual([{ fieldId: amountFieldId, direction: "desc", nullsFirst: false }]);
    expect(planOf(`sort amount asc`).query.sort).toEqual([{ fieldId: amountFieldId, direction: "asc" }]);
    expect(rowSqlOf(`sort amount asc nulls first`)).toContain("ASC NULLS FIRST");
  });

  test("default sort null ordering matches saved-view compiler semantics", () => {
    const previewSql = rowSqlOf(`sort amount asc`);
    expect(previewSql).toContain("ASC NULLS LAST");

    const view = resolveDslQueryToRecordQuery(parseOk(`sort amount asc`), ctx());
    expect(view.ok).toBe(true);
    if (!view.ok) throw new Error(view.diagnostics.map((d) => d.message).join("; "));

    const savedViewSql = compileDslQueryPlanToSql(
      { ...view.plan, readableTableIds: [orders.id, customers.id, regions.id, cities.id, countries.id] },
      { fieldsByTableId: ctx().fieldsByTableId },
    );
    expect(savedViewSql.ok).toBe(true);
    if (!savedViewSql.ok) throw new Error(savedViewSql.error);
    expect(normalizedSql(savedViewSql.query.sql)).toContain("ASC NULLS LAST");
  });

  test("include deleted lists live + trashed; deleted only lists trash", () => {
    expect(planOf(`select amount`).query.includeDeleted).toBeUndefined();
    expect(planOf(`select amount\ninclude deleted`).query.includeDeleted).toBe(true);
    expect(planOf(`select amount\ndeleted only`).query.deletedOnly).toBe(true);

    expect(rowSqlOf(`select amount`)).toContain("r.deleted_at IS NULL");
    expect(rowSqlOf(`select amount\ndeleted only`)).toContain("r.deleted_at IS NOT NULL");
    const includeSql = rowSqlOf(`select amount\ninclude deleted`);
    expect(includeSql).not.toContain("r.deleted_at IS NULL");
    expect(includeSql).not.toContain("r.deleted_at IS NOT NULL");
  });

  test("include deleted and deleted only cannot be combined", () => {
    const parsed = parseGridsQueryDsl(`select amount\ninclude deleted\ndeleted only`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.diagnostics.map((d) => d.message)).toContain('"include deleted" and "deleted only" cannot be combined');
  });

  test("grouped median / earliest / latest resolve to grouped aggregations", () => {
    const median = planOf(`group by status\naggregate median(amount) as mid`);
    expect(median.query.aggregations).toEqual([{ fieldId: amountFieldId, agg: "median", label: "mid" }]);

    const earliest = planOf(`group by status\naggregate earliest(ordered_at) as first_at`);
    expect(earliest.query.aggregations).toEqual([{ fieldId: orderedAtFieldId, agg: "earliest", label: "first_at" }]);
  });

  test("grouped median keeps the middle values numeric in SQL", () => {
    const compiled = compileDslGroupedQueryPlanToSql(planOf(`group by status\naggregate median(amount) as mid`), {
      fieldsByTableId: ctx().fieldsByTableId,
    });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(normalizedSql(compiled.query.sql)).toContain("PERCENTILE_DISC");
      expect(normalizedSql(compiled.query.sql)).not.toContain("PERCENTILE_CONT");
    }
  });

  test("search resolves to a RecordQuery search spec (default and scoped fields)", () => {
    expect(planOf(`search 'open'`).query.search).toEqual({ q: "open" });
    expect(planOf(`search 'open' in customer, status`).query.search).toEqual({
      q: "open",
      fieldIds: [customerFieldId, statusFieldId],
    });
  });

  test("search can target joined fields without pretending to be a RecordQuery search", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        search 'Alice' in status, customer.name
      `),
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.query.search).toEqual({ q: "Alice", fieldIds: [statusFieldId] });
    expect(result.plan.sqlSearch).toEqual([{ q: "Alice", tableId: customers.id, joinAlias: "customer", fieldIds: [customerNameFieldId] }]);
  });

  test("a search clause is representable as RecordQuery", () => {
    const view = resolveDslQueryToRecordQuery(parseOk(`from table Orders\nsearch 'open'`), ctx());
    expect(view.ok).toBe(true);
    if (view.ok) expect(view.plan.query.search).toEqual({ q: "open" });
  });

  test("joined search clauses are not representable as RecordQuery", () => {
    const view = resolveDslQueryToRecordQuery(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        search 'Alice' in customer.name
      `),
      ctx(),
    );
    expect(view.ok).toBe(false);
    if (!view.ok)
      expect(view.diagnostics.map((d) => d.message)).toEqual([
        "queries with relation joins cannot be represented by the records-table runtime yet",
      ]);
  });

  test("search over an unknown field errors clearly", () => {
    const result = resolveDslQueryToQueryPlan(parseOk(`search 'x' in nope`), ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(['unknown field "nope"']);
  });
});
