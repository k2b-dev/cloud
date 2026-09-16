import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { compileFilter, renderClause } from "../service/filter-compiler";
import type { FormulaSqlExpression } from "../service/formula-sql-values";
import { compileSort } from "../service/sort-compiler";
import { field, normalizedSql, orders } from "./resolver-fixtures";
import { createDslScopedFormulaFieldResolver } from "./scoped-formula";
import { fieldProjection, sortProjectionForField } from "./sql-compiler-fields";
import { aggregateExprForField, groupFieldProjection } from "./sql-compiler-grouping";
import { compileViewSourceRecordScope } from "./sql-compiler-scope";
import { compileWherePredicate } from "./sql-compiler-where";

const amount = field({ id: "amount-id", shortId: "Amount", name: "Amount", type: "number" });
const prepared: FormulaSqlExpression = { sql: sql`mapped_amount`, type: "numeric", errorSql: sql`mapped_error` };
const computedFieldSql = new Map([[amount.id, prepared]]);
const options = { fieldsByTableId: { [orders.id]: [amount] }, computedFieldSql };
const checked = "grids.require_valid_calculation(mapped_error, mapped_amount)";

const projectedSql = (result: ReturnType<typeof fieldProjection>) => {
  if (!result.ok) throw new Error(result.error);
  return normalizedSql(result.projection);
};

describe("prepared ordinary field values retain calculation errors", () => {
  test("selection and sorting consume the prepared value at the query boundary", () => {
    expect(projectedSql(fieldProjection(amount, "r", options))).toBe(checked);
    expect(projectedSql(sortProjectionForField(amount, "r", options))).toBe(checked);
    const sort = compileSort([{ fieldId: amount.id, direction: "asc" }], [amount], null, computedFieldSql);
    if (!sort.ok) throw new Error(sort.error);
    expect(normalizedSql(sort.result.orderBy)).toContain(checked);
  });

  test("filter leaves, including empty checks beneath OR and NOT, guard the prepared value", () => {
    const filtered = compileFilter({ fieldId: amount.id, op: "isEmpty" }, [amount]);
    if (!filtered.ok) throw new Error(filtered.error);
    const rendered = renderClause({ kind: "not", inner: { kind: "or", parts: [filtered.clause] } }, options);
    const query = normalizedSql(rendered);
    expect(query).toContain("NOT (");
    expect(query).toContain(checked);
    expect(query).toContain("IS NULL");
    expect(query).not.toContain("r.data");
    const predicate = compileWherePredicate(
      {
        kind: "or",
        parts: [
          { kind: "filter", leaf: { fieldId: amount.id, op: ">", value: 2 } },
          { kind: "not", part: { kind: "filter", leaf: { fieldId: amount.id, op: "isEmpty" } } },
        ],
      },
      [amount],
      options,
    );
    if (!predicate.ok) throw new Error(predicate.error);
    expect(normalizedSql(predicate.sql).match(/grids.require_valid_calculation/g)).toHaveLength(2);
  });

  test("joined filters use their own prepared map", () => {
    const result = compileWherePredicate(
      {
        kind: "scoped",
        joinAlias: "other",
        tableId: orders.id,
        predicate: { kind: "filter", leaf: { fieldId: amount.id, op: ">", value: 2 } },
      },
      [],
      {
        ...options,
        joinAliases: new Map([["other", "jq0"]]),
        computedFieldSqlByJoinAlias: new Map([
          [
            "other",
            new Map([
              [
                amount.id,
                {
                  sql: sql`joined_amount`,
                  type: "numeric",
                  errorSql: sql`joined_error`,
                },
              ],
            ]),
          ],
        ]),
      },
    );
    if (!result.ok) throw new Error(result.error);
    expect(normalizedSql(result.sql)).toContain("grids.require_valid_calculation(joined_error, joined_amount)");
    expect(normalizedSql(result.sql)).not.toContain("mapped_error");
  });

  test("group keys and aggregate arguments guard ordinary mapped fields", () => {
    const group = groupFieldProjection({ fieldId: amount.id, tableId: orders.id }, amount, "r", options, 0);
    if (!group.ok) throw new Error(group.error);
    expect(normalizedSql(group.expr)).toBe(checked);
    for (const agg of ["sum", "avg", "min", "max", "count", "countEmpty", "countUnique"] as const) {
      const aggregate = aggregateExprForField({ fieldId: amount.id, tableId: orders.id, agg }, amount, "r", options);
      if (!aggregate.ok) throw new Error(aggregate.error);
      expect(normalizedSql(aggregate.expr)).toContain(checked);
    }
  });

  test("date buckets and exploding select buckets retain prepared error guards", () => {
    const date = field({ id: "date-id", shortId: "Date", name: "Date", type: "date" });
    const select = field({ id: "select-id", shortId: "Tags", name: "Tags", type: "select", config: { multiple: true } });
    for (const value of [date, select]) {
      const computedFieldSql = new Map<string, FormulaSqlExpression>([
        [
          value.id,
          {
            sql: sql`mapped_value`,
            errorSql: sql`mapped_error`,
            type: value.type === "date" ? "date" : "unknown",
          },
        ],
      ]);
      const group = groupFieldProjection(
        { fieldId: value.id, tableId: orders.id, ...(value.type === "date" ? { granularity: "month" as const } : {}) },
        value,
        "r",
        { ...options, computedFieldSql },
        0,
      );
      if (!group.ok) throw new Error(group.error);
      expect(normalizedSql(value.type === "select" ? group.joins?.[0] : group.expr)).toContain(
        "grids.require_valid_calculation(mapped_error,",
      );
    }
  });

  test("saved-view filters and sorts receive the same prepared values", () => {
    const source = compileViewSourceRecordScope(
      {
        tableId: orders.id,
        viewSourceQuery: {
          filter: { fieldId: amount.id, op: ">", value: 2 },
          sort: [{ fieldId: amount.id, direction: "asc" }],
        },
      },
      [amount],
      options,
    );
    if (!source.ok) throw new Error(source.error);
    expect(normalizedSql(source.condition).match(/grids.require_valid_calculation/g)).toHaveLength(2);
  });

  test("qualified formula references preserve the value/error pair so IFERROR can consume it", () => {
    const resolve = createDslScopedFormulaFieldResolver({ base: { alias: "base", fields: [amount], recordAlias: "r", computedFieldSql } });
    expect(resolve("base.Amount")).toBe(prepared);
    expect(normalizedSql(prepared.sql)).not.toContain("require_valid_calculation");
  });
});
