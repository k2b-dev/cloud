import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testShortId } from "../integration-test-utils";
import { migrate } from "../migrate";
import { decodeDslResultCursor } from "./result-cursor";
import {
  cleanupFixture,
  insertDslDbFixture,
  integrationCursorSigningKey,
  postgresTest,
  preview,
  previewPage,
  uuid,
} from "./sql-compiler.integration-fixtures";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("Query DSL Postgres smoke — joins and grouped joins", () => {
  postgresTest("filters, sorts and pages every linked record beyond the first fifty", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const ids = Array.from({ length: 51 }, () => uuid()).sort();
      await sql.begin(async (tx) => {
        for (const [index, id] of ids.entries()) {
          await tx`INSERT INTO grids.records (id, short_id, table_id, data)
            VALUES (${id}::uuid, ${testShortId("R")}, ${fixture.customers.id}::uuid,
              ${{ [fixture.customerNameId]: index === 50 ? "Needle" : "Other", [fixture.customerScoreId]: index }}::jsonb)`;
          await tx`INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position)
            VALUES (${fixture.orderCId}::uuid, ${fixture.customerLinkId}::uuid, ${id}::uuid, ${index})`;
        }
      });
      const source = `from table Orders\njoin table Customers as customer on Customer = customer.id\nselect customer.Name as name, customer.Score as score`;
      const filtered = await preview(fixture, `${source}\nwhere customer.Name = 'Needle'`);
      expect(filtered.rows).toHaveLength(1);
      expect(filtered.rows[0]?.values.q_col_0).toBe("Needle");
      const sorted = await preview(fixture, `${source}\nsort customer.Score desc\nlimit 1`);
      expect(Number(sorted.rows[0]?.values.q_col_1)).toBe(50);
      const seen: unknown[] = [];
      let cursor: ReturnType<typeof decodeDslResultCursor> = null;
      do {
        const page = await previewPage(fixture, `${source}\nwhere customer.Score >= 0\nsort customer.Score asc`, { pageSize: 17, cursor });
        seen.push(...page.rows.map((row) => row.values.q_col_0));
        cursor = decodeDslResultCursor(page.page?.nextCursor, integrationCursorSigningKey);
      } while (cursor);
      // The fixture's two original customer links also remain in the result.
      expect(seen.filter((name) => name === "Other")).toHaveLength(50);
      expect(seen.filter((name) => name === "Needle")).toHaveLength(1);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes select labels, membership, null ordering, and trash clauses", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const open = await preview(fixture, `where STAGEx = 'Open'`);
      expect(open.mode).toBe("rows");
      expect(open.rows.map((row) => row.recordId)).toEqual([fixture.orderAId]);

      const membership = await preview(fixture, `where oneof(STAGEx, 'Open', 'Closed')\nsort AMT01x asc`);
      expect(membership.rows.map((row) => row.recordId)).toEqual([fixture.orderBId, fixture.orderAId]);

      const nullsLast = await preview(fixture, `select AMT01x\nsort AMT01x asc`);
      expect(nullsLast.rows.map((row) => row.recordId)).toEqual([fixture.orderBId, fixture.orderAId, fixture.orderCId]);

      const nullsFirst = await preview(fixture, `select AMT01x\nsort AMT01x asc nulls first`);
      expect(nullsFirst.rows.map((row) => row.recordId)).toEqual([fixture.orderCId, fixture.orderBId, fixture.orderAId]);

      const deletedOnly = await preview(fixture, `select STAT1x\ndeleted only`);
      expect(deletedOnly.rows.map((row) => row.recordId)).toEqual([fixture.orderDeletedId]);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes readable table, field, and join references", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const result = await preview(
        fixture,
        `
          from table Orders
          join table Customers as customer on Customer = customer.id
          select Amount as order_amount, customer.Name as customer_label, formula(Amount - Cost) as line_margin
          where Amount > Cost
          sort customer_label asc
          limit 10
        `,
      );

      expect(result.mode).toBe("rows");
      expect(result.rows).toHaveLength(1);
      expect(Number(result.rows[0]?.values.q_col_0)).toBe(12.5);
      expect(result.rows[0]?.values.q_col_1).toBe("Alice");
      expect(Number(result.rows[0]?.values.q_col_2)).toBe(7.5);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes source aliases and self-joins", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const result = await preview(
        fixture,
        `
          from table ${fixture.orders.shortId} as o
          join table ${fixture.orders.shortId} as parent on o.PARNTx = parent.id
          select o.AMT01x as order_amount, parent.AMT01x as parent_amount
          sort o.AMT01x asc
          limit 10
        `,
      );

      expect(result.mode).toBe("rows");
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.recordId).toBe(fixture.orderBId);
      expect(Number(result.rows[0]?.values.q_col_0)).toBe(4);
      expect(Number(result.rows[0]?.values.q_col_1)).toBe(12.5);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes reverse relation joins", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const result = await preview(
        fixture,
        `
          from table ${fixture.customers.shortId} as c
          join table ${fixture.orders.shortId} as order on order.CUSTLx = c.id
          select c.NAME1x as customer_name, order.AMT01x as order_amount
          sort order.AMT01x asc
        `,
      );

      expect(result.mode).toBe("rows");
      expect(result.rows.map((row) => row.recordId)).toEqual([fixture.customerBId, fixture.customerAId]);
      expect(result.rows[0]?.values.q_col_0).toBe("Bob");
      expect(Number(result.rows[0]?.values.q_col_1)).toBe(4);
      expect(result.rows[1]?.values.q_col_0).toBe("Alice");
      expect(Number(result.rows[1]?.values.q_col_1)).toBe(12.5);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes grouped relation joins with joined aggregates", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const result = await preview(
        fixture,
        `
          from table ${fixture.customers.shortId} as c
          join table ${fixture.orders.shortId} as order on order.CUSTLx = c.id
          group by c.NAME1x
          aggregate sum(order.AMT01x) as revenue
          sort revenue desc
        `,
      );

      expect(result.mode).toBe("groups");
      expect(result.rows.map((row) => row.values.gk_0)).toEqual(["Alice", "Bob"]);
      const byCustomer = new Map(result.rows.map((row) => [row.values.gk_0, row.values]));
      expect(Number(byCustomer.get("Alice")?.[`${fixture.amountId}__sum`])).toBe(12.5);
      expect(Number(byCustomer.get("Bob")?.[`${fixture.amountId}__sum`])).toBe(4);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes grouped relation joins with exploded joined group keys", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const tags = await preview(
        fixture,
        `
          from table ${fixture.customers.shortId} as c
          join table ${fixture.orders.shortId} as order on order.CUSTLx = c.id
          group by order.TAGS1x
          aggregate count(*) as rows
          sort rows desc
        `,
      );
      expect(tags.mode).toBe("groups");
      expect(tags.explode).toBe(true);
      const byTag = new Map(tags.rows.map((row) => [row.values.gk_0, Number(row.values["*__count"])]));
      expect(byTag).toEqual(
        new Map([
          ["remote", 2],
          ["priority", 1],
        ]),
      );

      const implicitCount = await preview(
        fixture,
        `
          from table ${fixture.customers.shortId} as c
          join table ${fixture.orders.shortId} as order on order.CUSTLx = c.id
          group by order.TAGS1x
        `,
      );
      expect(implicitCount.mode).toBe("groups");
      expect(implicitCount.explode).toBe(true);
      const implicitByTag = new Map(implicitCount.rows.map((row) => [row.values.gk_0, Number(row.values["*__count"])]));
      expect(implicitByTag).toEqual(
        new Map([
          ["remote", 2],
          ["priority", 1],
        ]),
      );

      const parent = await preview(
        fixture,
        `
          from table ${fixture.customers.shortId} as c
          join table ${fixture.orders.shortId} as order on order.CUSTLx = c.id
          group by order.PARNTx
          aggregate count(*) as rows
        `,
      );
      expect(parent.mode).toBe("groups");
      expect(parent.explode).toBe(true);
      expect(parent.rows).toHaveLength(1);
      expect(Number(parent.rows[0]?.values["*__count"])).toBe(1);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes grouped relation joins with base formula aggregates", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const result = await preview(
        fixture,
        `
          from table ${fixture.orders.shortId}
          join table ${fixture.customers.shortId} as customer on CUSTLx = customer.id
          group by customer.NAME1x
          aggregate sum(formula(AMT01x - COST1x)) as margin
          having margin > 0
          sort margin desc
        `,
      );

      expect(result.mode).toBe("groups");
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.values.gk_0).toBe("Alice");
      expect(Number(result.rows[0]?.values.margin__sum)).toBe(7.5);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes grouped relation joins with computed joined group keys", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const formula = await preview(
        fixture,
        `
          from table ${fixture.orders.shortId}
          join table ${fixture.customers.shortId} as customer on CUSTLx = customer.id
          group by customer.SCOR2x
          aggregate count(*) as rows
        `,
      );
      expect(formula.mode).toBe("groups");
      const byScore = new Map(formula.rows.map((row) => [Number(row.values.gk_0), Number(row.values["*__count"])]));
      expect(byScore.size).toBe(2);
      expect(byScore.get(16)).toBe(1);
      expect(byScore.get(6)).toBe(1);

      const lookup = await preview(
        fixture,
        `
          from table ${fixture.orders.shortId}
          join table ${fixture.customers.shortId} as customer on CUSTLx = customer.id
          group by customer.FAMT1x
          aggregate count(*) as rows
        `,
      );
      expect(lookup.mode).toBe("groups");
      const byLookup = new Map(lookup.rows.map((row) => [Number(row.values.gk_0), Number(row.values["*__count"])]));
      expect(byLookup.size).toBe(2);
      expect(byLookup.get(12.5)).toBe(1);
      expect(byLookup.get(4)).toBe(1);

      const rollup = await preview(
        fixture,
        `
          from table ${fixture.orders.shortId}
          join table ${fixture.customers.shortId} as customer on CUSTLx = customer.id
          group by customer.FSUM1x
          aggregate count(*) as rows
        `,
      );
      expect(rollup.mode).toBe("groups");
      const byRollup = new Map(rollup.rows.map((row) => [Number(row.values.gk_0), Number(row.values["*__count"])]));
      expect(byRollup.size).toBe(2);
      expect(byRollup.get(12.5)).toBe(1);
      expect(byRollup.get(4)).toBe(1);

      const aggregate = await preview(
        fixture,
        `
          from table ${fixture.orders.shortId}
          join table ${fixture.customers.shortId} as customer on CUSTLx = customer.id
          group by customer.NAME1x
          aggregate sum(customer.FSUM1x) as favorite_total
          sort favorite_total desc
        `,
      );
      expect(aggregate.mode).toBe("groups");
      const byName = new Map(aggregate.rows.map((row) => [row.values.gk_0, Number(row.values.favorite_total__sum)]));
      expect(byName).toEqual(
        new Map([
          ["Alice", 12.5],
          ["Bob", 4],
        ]),
      );

      const lookupAggregate = await preview(
        fixture,
        `
          from table ${fixture.orders.shortId}
          join table ${fixture.customers.shortId} as customer on CUSTLx = customer.id
          group by customer.NAME1x
          aggregate sum(customer.FAMT1x) as favorite_lookup_total, avg(customer.FAMT1x) as favorite_lookup_avg
          sort favorite_lookup_total desc
        `,
      );
      expect(lookupAggregate.mode).toBe("groups");
      const lookupByName = new Map(
        lookupAggregate.rows.map((row) => [
          row.values.gk_0,
          {
            avg: Number(row.values.favorite_lookup_avg__avg),
            total: Number(row.values.favorite_lookup_total__sum),
          },
        ]),
      );
      expect(lookupByName).toEqual(
        new Map([
          ["Alice", { avg: 12.5, total: 12.5 }],
          ["Bob", { avg: 4, total: 4 }],
        ]),
      );
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes base computed fields as group keys", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const formula = await preview(
        fixture,
        `
          from table ${fixture.customers.shortId}
          group by SCOR2x
          aggregate count(*) as rows
          sort SCOR2x asc
        `,
      );
      expect(formula.mode).toBe("groups");
      expect(formula.rows.map((row) => [Number(row.values.gk_0), Number(row.values["*__count"])])).toEqual([
        [6, 1],
        [16, 1],
      ]);

      const lookup = await preview(
        fixture,
        `
          from table ${fixture.customers.shortId}
          group by FAMT1x
          aggregate count(*) as rows
          sort FAMT1x asc
        `,
      );
      expect(lookup.mode).toBe("groups");
      expect(lookup.rows.map((row) => [Number(row.values.gk_0), Number(row.values["*__count"])])).toEqual([
        [4, 1],
        [12.5, 1],
      ]);

      const rollup = await preview(
        fixture,
        `
          from table ${fixture.customers.shortId}
          group by FSUM1x
          aggregate count(*) as rows
          sort FSUM1x asc
        `,
      );
      expect(rollup.mode).toBe("groups");
      expect(rollup.rows.map((row) => [Number(row.values.gk_0), Number(row.values["*__count"])])).toEqual([
        [4, 1],
        [12.5, 1],
      ]);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });
});
