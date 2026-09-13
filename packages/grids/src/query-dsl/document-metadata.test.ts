import { expect, test } from "bun:test";
import { compileFormulaSourceToSql } from "../service/formula-sql-compiler";
import { resolveDslQueryToQueryPlan } from "./resolver";
import { ctx, fields, normalizedSql, orders, parseOk } from "./resolver-fixtures";
import { compileDslQueryPlanToSql } from "./sql-compiler";

test("document metadata selects and predicates compile as indexed record membership subqueries", () => {
  const ast = parseOk(
    "from table Orders\nselect documentCount('sepa-xml') as exports, latestDocumentAt('sepa-xml') as latest\nwhere documentCount('sepa-xml') = 0",
  );
  const resolved = resolveDslQueryToQueryPlan(ast, ctx());
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
  const compiled = compileDslQueryPlanToSql(resolved.plan, { fieldsByTableId: { [orders.id]: fields } });
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error(compiled.error);
  expect(normalizedSql(compiled.query.sql)).toContain("document_record_sources");
  expect(compiled.query.columns.map((column) => column.sqlType)).toEqual(["numeric", "datetime"]);
});

test("document metadata rejects unsupported formats and restricted app queries", () => {
  for (const source of ["documentCount('sepa')", "documentCount('pdf', 'csv')", "latestDocumentAt(amount)"]) {
    expect(resolveDslQueryToQueryPlan(parseOk(`from table Orders\nselect ${source} as docs`), ctx()).ok).toBe(false);
  }
  expect(
    resolveDslQueryToQueryPlan(parseOk("from table Orders\nselect documentCount() as docs"), { ...ctx(), documentMetadata: false }).ok,
  ).toBe(false);
  expect(compileFormulaSourceToSql("documentCount()", { fields }).ok).toBe(false);
});
