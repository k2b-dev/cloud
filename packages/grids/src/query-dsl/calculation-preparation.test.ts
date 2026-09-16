import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { buildComputedFieldSqlMap } from "../service/computed-projections";
import type { FormulaSqlExpression } from "../service/formula-sql-compiler";
import { dslQueryCalculationFieldIds } from "./plan-dependencies";
import { resolveDslQueryToQueryPlan } from "./resolver";
import { ctx, customerFields, customers, field, fields, orders, parseOk } from "./resolver-fixtures";
import { createDslScopedFormulaFieldResolver } from "./scoped-formula";

const margin = field({
  id: "ffffffff-ffff-4fff-8fff-fffffffffff1",
  tableId: orders.id,
  shortId: "margin",
  name: "Margin",
  type: "formula",
  config: { expression: "amount - cost" },
});
const total = field({
  id: "ffffffff-ffff-4fff-8fff-fffffffffff2",
  tableId: orders.id,
  shortId: "total",
  name: "Total",
  type: "formula",
  config: { expression: "margin * 2" },
});
const unused = field({
  id: "ffffffff-ffff-4fff-8fff-fffffffffff3",
  tableId: orders.id,
  shortId: "unused",
  name: "Unused",
  type: "formula",
  config: { expression: "1 / 0" },
});
const score = field({
  id: "ffffffff-ffff-4fff-8fff-fffffffffff4",
  tableId: customers.id,
  shortId: "scorex",
  name: "Score doubled",
  type: "formula",
  config: { expression: "score * 2" },
});
const orderFields = [...fields.map((item) => ({ ...item, tableId: orders.id })), margin, total, unused];
const fieldsByTableId = { [orders.id]: orderFields, [customers.id]: [...customerFields, score] };
const planOf = (source: string) => {
  const resolved = resolveDslQueryToQueryPlan(parseOk(source), ctx({ fieldsByTableId }));
  if (!resolved.ok) throw new Error(resolved.diagnostics.map((item) => item.message).join("; "));
  return resolved.plan;
};

describe("GQL calculation preparation", () => {
  test.each([
    "select total",
    "select formula(total + 1) as result",
    "select amount\nwhere total > 10",
    "select amount\nsort total desc",
    "aggregate sum(total) as result",
    "aggregate sum(formula(total + 1)) as result",
    "from table Orders as invoice\nselect formula(invoice.total + 1) as result",
    "from table Orders as invoice\nselect amount\nwhere invoice.total > 10",
  ])("keeps transitive formula dependencies for %s", async (source) => {
    const ids = dslQueryCalculationFieldIds(planOf(source), fieldsByTableId);
    expect(ids.has(total.id)).toBe(true);
    expect(ids.has(margin.id)).toBe(true);
    expect(ids.has(unused.id)).toBe(false);
    const prepared = await buildComputedFieldSqlMap(orderFields, { fieldsByTableId, fieldIds: ids });
    expect([...prepared.keys()].sort()).toEqual([margin.id, total.id].sort());
  });

  test.each(["select amount", "aggregate count(*) as rows", "select formula(amount + 1) as result"])(
    "prepares no unrelated formulas for %s",
    async (source) => {
      const ids = dslQueryCalculationFieldIds(planOf(source), fieldsByTableId);
      expect((await buildComputedFieldSqlMap(orderFields, { fieldsByTableId, fieldIds: ids })).size).toBe(0);
    },
  );

  test("implicit selection retains every selectable formula", () => {
    const ids = dslQueryCalculationFieldIds(planOf("from table Orders"), fieldsByTableId);
    for (const item of [margin, total, unused]) expect(ids.has(item.id)).toBe(true);
  });

  test("joined formula expressions retain their target dependencies", () => {
    const plan = planOf(
      "from table Orders\nleft join table Customers as c on customer_link = c.id\nselect formula(c.scorex + 1) as result",
    );
    const ids = dslQueryCalculationFieldIds(plan, fieldsByTableId);
    expect(ids.has(score.id)).toBe(true);
    expect(ids.has(customerFields.find((item) => item.shortId === "score")!.id)).toBe(true);
    expect(ids.has(unused.id)).toBe(false);
  });

  test("formula preparation retains transitive lookup and relation dependencies", () => {
    const lookup = field({
      ...margin,
      type: "lookup",
      config: { relationFieldId: fields.find((item) => item.type === "relation")!.id, targetFieldId: customerFields[0]!.id },
    });
    const schema = { ...fieldsByTableId, [orders.id]: orderFields.map((item) => (item.id === margin.id ? lookup : item)) };
    const ids = dslQueryCalculationFieldIds(planOf("select total"), schema);
    expect(ids.has(lookup.id)).toBe(true);
    expect(ids.has(fields.find((item) => item.type === "relation")!.id)).toBe(true);
    expect(ids.has(customerFields[0]!.id)).toBe(true);
  });

  test("scoped references reuse the exact prepared value and error plan", () => {
    const prepared: FormulaSqlExpression = { sql: sql`42::numeric`, errorSql: sql`false`, type: "numeric" };
    const resolve = createDslScopedFormulaFieldResolver({
      base: { alias: "invoice", fields: orderFields, recordAlias: "r", computedFieldSql: new Map([[total.id, prepared]]) },
      joins: [{ alias: "customer", fields: [score], recordAlias: "j0", computedFieldSql: new Map([[score.id, prepared]]) }],
    });
    expect(resolve("invoice.total")).toBe(prepared);
    expect(resolve('customer."Score doubled"')).toBe(prepared);
  });
});
