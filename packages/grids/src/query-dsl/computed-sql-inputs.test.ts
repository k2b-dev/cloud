import { expect, test } from "bun:test";
import { buildDslComputedSqlInputs } from "./computed-sql-inputs";
import { resolveDslQueryToQueryPlan } from "./resolver";
import {
  amountFieldId,
  ctx,
  customerFields,
  customerLinkFieldId,
  customerScoreFieldId,
  customers,
  field,
  fields,
  orders,
  parseOk,
} from "./resolver-fixtures";
import { compileDslDerivedViewSourcePlanToSql, compileDslQueryPlanToSql } from "./sql-compiler";

const lookup = field({
  id: "ffffffff-ffff-4fff-8fff-fffffffffff1",
  tableId: orders.id,
  shortId: "points",
  name: "Points",
  type: "lookup",
  config: { relationFieldId: customerLinkFieldId, targetFieldId: customerScoreFieldId },
});
const formula = field({
  id: "ffffffff-ffff-4fff-8fff-fffffffffff2",
  tableId: orders.id,
  shortId: "double",
  name: "Double",
  type: "formula",
  config: { expression: "points * 2" },
});
const joinedFormula = field({
  id: "ffffffff-ffff-4fff-8fff-fffffffffff3",
  tableId: customers.id,
  shortId: "double",
  name: "Double",
  type: "formula",
  config: { expression: "score * 2" },
});
const fieldsByTableId = {
  ...ctx().fieldsByTableId,
  [orders.id]: [...fields.map((item) => ({ ...item, tableId: orders.id })), lookup, formula],
  [customers.id]: [...customerFields, joinedFormula],
};
const view = {
  kind: "view" as const,
  id: "33333333-3333-4333-8333-333333333333",
  shortId: "Totals",
  name: "Totals",
  tableId: orders.id,
  query: { groupBy: [{ fieldId: customerLinkFieldId }], aggregations: [{ fieldId: amountFieldId, agg: "sum" as const, label: "total" }] },
};

// Preparation must be schema-only: these tests use real lookup/formula SQL,
// complete field metadata and no database connection or replacement expressions.
test.each([
  ["select points, double, ordered_at", ["numeric", "numeric", "date"]],
  ["from table Orders\nleft join table Customers as c on customer_link = c.id\nselect points, c.double", ["numeric", "numeric"]],
  ['from table Customers as c\nleft join view Totals as paid on paid."Customer link" = c.id\nselect paid.total', ["numeric"]],
  ["from view Totals\nselect total", ["numeric"]],
] as const)("prepared metadata compiles %s without reading records", async (source, types) => {
  const resolved = resolveDslQueryToQueryPlan(parseOk(source), ctx({ fieldsByTableId, views: [view] }));
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
  const inputs = { fieldsByTableId, ...(await buildDslComputedSqlInputs(resolved.plan, { fieldsByTableId })) };
  const compiled = resolved.plan.derivedViewSource
    ? compileDslDerivedViewSourcePlanToSql(resolved.plan, inputs)
    : compileDslQueryPlanToSql(resolved.plan, inputs);
  if (!compiled.ok) throw new Error(compiled.error);
  expect(compiled.query.columns.map((column) => column.sqlType)).toEqual([...types]);
});
