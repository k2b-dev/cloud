import { beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { migrate } from "../migrate";
import { compileFormulaSourceToSql } from "../service/formula-sql-compiler";
import { createDslScopedFormulaFieldResolver } from "./scoped-formula";
import {
  cleanupFixture,
  field,
  insertDslDbFixture,
  postgresTest,
  preview,
  refreshFixtureCalculations,
} from "./sql-compiler.integration-fixtures";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

postgresTest("joined list reductions use typed calculated cells and preserve frozen values", async () => {
  const fixture = await insertDslDbFixture();
  try {
    const list = field({
      id: Bun.randomUUIDv7(),
      shortId: "ITEMS1",
      tableId: fixture.customers.id,
      name: "Items",
      type: "object_list",
      config: {
        fields: [
          { id: "Amount", name: "Amount", type: "number" },
          { id: "Total1", name: "Total", type: "number", formula: { expression: "Amount * 2" } },
        ],
      },
    });
    fixture.fieldsByTableId[fixture.customers.id]!.push(list);
    await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config)
      VALUES (${list.id}::uuid, ${list.shortId}, ${list.tableId}::uuid, ${list.name}, ${list.type}, ${list.config}::jsonb)`;
    await sql`UPDATE grids.records SET data = data || ${{ [list.id]: [{ Amount: "0.15", Total1: "9.99" }] }}::jsonb
      WHERE id = ${fixture.customerAId}::uuid`;
    await refreshFixtureCalculations(fixture);
    const source = `from table ${fixture.orders.shortId}
      join table ${fixture.customers.shortId} as customer on CUSTLx = customer.id`;
    const query = `${source}
      select formula(LIST_SUM(customer.ITEMS1, 'Total')) as total, formula(LIST_COUNT(customer.ITEMS1)) as count
      where customer.NAME1x = 'Alice'`;
    const draft = await preview(fixture, query);
    expect(draft.rows).toHaveLength(1);
    expect(draft.rows[0]?.values).toMatchObject({ q_col_0: "0.3", q_col_1: "1" });
    const grouped = await preview(
      fixture,
      `${source}
      group by customer.NAME1x
      aggregate sum(formula(LIST_SUM(customer.ITEMS1, 'Total'))) as total
      sort customer.NAME1x asc`,
    );
    expect(grouped.rows[0]?.values).toMatchObject({ gk_0: "Alice", total__sum: "0.3" });
    const frozen = compileFormulaSourceToSql("LIST_SUM(customer.ITEMS1, 'Total')", {
      fields: [],
      scopedRefs: true,
      resolveField: createDslScopedFormulaFieldResolver({
        base: { fields: [], recordAlias: "r" },
        joins: [{ alias: "customer", fields: [list], recordAlias: "customer" }],
      }),
    });
    if (!frozen.ok) throw new Error(frozen.error);
    const [stored] = await sql`SELECT (${frozen.expression.sql})::text AS total
      FROM (SELECT data, NOW() AS finalized_at FROM grids.records WHERE id = ${fixture.customerAId}::uuid) customer`;
    expect(stored.total).toBe("9.99");
    await sql`UPDATE grids.records SET data = data || ${{ [list.id]: [{ Amount: "invalid" }] }}::jsonb
      WHERE id = ${fixture.customerAId}::uuid`;
    await refreshFixtureCalculations(fixture);
    const calculationError = "This value could not be calculated. Check the formula and its input values.";
    await expect(preview(fixture, query)).rejects.toThrow(calculationError);
    await expect(preview(fixture, `${source}\n select customer.ITEMS1\n where customer.NAME1x = 'Alice'`)).rejects.toThrow(
      calculationError,
    );
    await expect(
      preview(fixture, `${source}\n group by customer.NAME1x\n aggregate sum(formula(LIST_SUM(customer.ITEMS1, 'Total'))) as total`),
    ).rejects.toThrow(calculationError);
    const recovered = await preview(
      fixture,
      `${source}\n select formula(IFERROR(LIST_SUM(customer.ITEMS1, 'Total'), 42)) as total, formula(IF(false, LIST_SUM(customer.ITEMS1, 'Total'), 7)) as unused
        where customer.NAME1x = 'Alice'`,
    );
    expect(recovered.rows[0]?.values).toMatchObject({ q_col_0: "42", q_col_1: "7" });
  } finally {
    await cleanupFixture(fixture.baseId);
  }
});
