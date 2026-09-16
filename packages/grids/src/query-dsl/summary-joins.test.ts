import { expect, test } from "bun:test";
import { normalizedSql } from "../sql-test-utils";
import { canonicalizeDslQuery } from "./canonical";
import { resolveDslQueryToQueryPlan, resolveDslQueryToRecordQuery } from "./resolver";
import { amountFieldId, ctx, customerLinkFieldId, customers, orders, parseOk } from "./resolver-fixtures";
import { compileDslQueryPlanToSql } from "./sql-compiler";

const view = {
  kind: "view" as const,
  id: "33333333-3333-4333-8333-333333333333",
  shortId: "Totals",
  name: "Totals",
  tableId: orders.id,
  query: { groupBy: [{ fieldId: customerLinkFieldId }], aggregations: [{ fieldId: amountFieldId, agg: "sum" as const, label: "total" }] },
};
const context = ctx({ currentTable: customers, views: [view] });
const source = `from table Customers as customer
left join view Totals as paid on paid."Customer link" = customer.id
select name, paid.total, formula(score - IF(ISBLANK(paid.total), 0, paid.total)) as remaining
where paid.total > 0
sort remaining desc`;

test("summary plans keep metadata liveness independent from record cardinality", () => {
  const resolved = resolveDslQueryToQueryPlan(parseOk(source), context);
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
  const compiled = compileDslQueryPlanToSql(resolved.plan, { fieldsByTableId: context.fieldsByTableId });
  if (!compiled.ok) throw new Error(compiled.error);
  const text = normalizedSql(compiled.query.sql);
  // Both the parent record query and the child grouping check their fixed table
  // once. Joining either record stream through metadata can collapse estimates
  // and select quadratic nested loops when a small Base catalog has no stats.
  expect(text.match(/EXISTS \(\s*SELECT 1 FROM grids\.tables scope_table/g)).toHaveLength(2);
  expect(text).not.toMatch(/JOIN grids\.tables \w+ ON \w+\.id = r\.table_id/);
  expect(text).toContain("scope_base.deleted_at IS NULL");
  expect(text).toContain("scope_table.deleted_at IS NULL");
});

test("summary joins without a source alias round-trip through canonical GQL", () => {
  const ast = parseOk(source.replace("Customers as customer", "Customers").replace("customer.id", "id"));
  const canonical = canonicalizeDslQuery(ast, context);
  expect(canonical.ok).toBe(true);
  if (!canonical.ok) throw new Error(JSON.stringify(canonical.diagnostics));
  expect(resolveDslQueryToQueryPlan(parseOk(canonical.source), context).ok).toBe(true);
});

test("grouped-view joins resolve typed output, predicates and canonical round trips", () => {
  const ast = parseOk(source);
  const result = resolveDslQueryToQueryPlan(ast, context);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(result.plan.summaryJoins).toHaveLength(1);
  const canonical = canonicalizeDslQuery(ast, context);
  expect(canonical.ok).toBe(true);
  if (!canonical.ok) throw new Error(JSON.stringify(canonical.diagnostics));
  expect(resolveDslQueryToQueryPlan(parseOk(canonical.source), context).ok).toBe(true);
  expect(resolveDslQueryToRecordQuery(ast, context).ok).toBe(false);
});

test("summary joins reject truncation, row views, unrelated keys and outer grouping", () => {
  for (const query of [{ ...view.query, limit: 1 }, { ...view.query, search: { q: "x" } }, {}]) {
    expect(resolveDslQueryToQueryPlan(parseOk(source), ctx({ views: [{ ...view, query }] })).ok).toBe(false);
  }
  for (const invalid of [
    source.replace("left join", "join"),
    source.replace('paid."Customer link"', "paid.total"),
    `${source}\ngroup by name`,
  ]) {
    expect(resolveDslQueryToQueryPlan(parseOk(invalid), context).ok).toBe(false);
  }
});
