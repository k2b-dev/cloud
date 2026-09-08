import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { migrate } from "../migrate";
import { decodeDslResultCursor } from "./result-cursor";
import {
  cleanupFixture,
  insertDslDbFixture,
  integrationCursorSigningKey,
  postgresTest,
  preview,
  previewPage,
} from "./sql-compiler.integration-fixtures";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("Query DSL Postgres smoke — rows and text search", () => {
  postgresTest("paginates row queries with stable keyset cursors", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const source = `from table ${fixture.orders.shortId}\nselect AMT01x as ordered_amount\nsort ordered_amount asc\nlimit 2`;
      const first = await previewPage(fixture, source, { pageSize: 1 });
      expect(first.rows).toHaveLength(1);
      const cursor = decodeDslResultCursor(first.page?.nextCursor, integrationCursorSigningKey);
      expect(cursor).not.toBeNull();
      const second = await previewPage(fixture, source, { pageSize: 1, cursor });
      expect(second.rows).toHaveLength(1);
      expect(second.rows[0]?.recordId).not.toBe(first.rows[0]?.recordId);
      expect(Number(second.rows[0]?.values.q_col_0)).toBeGreaterThan(Number(first.rows[0]?.values.q_col_0));
      expect(second.page?.nextCursor).toBeNull();
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("paginates short text sorts without omissions", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const source = `from table ${fixture.orders.shortId}\nsort STAT1x asc`;
      const recordIds: string[] = [];
      let cursor: ReturnType<typeof decodeDslResultCursor> = null;
      do {
        const page = await previewPage(fixture, source, { pageSize: 1, cursor });
        expect(page.rows).toHaveLength(1);
        recordIds.push(page.rows[0]!.recordId!);
        cursor = decodeDslResultCursor(page.page?.nextCursor, integrationCursorSigningKey);
      } while (cursor);

      expect(new Set(recordIds).size).toBe(3);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("falls back to signed offset pagination when a text sort key cannot fit in a cursor", async () => {
    const fixture = await insertDslDbFixture();
    try {
      await sql`
        UPDATE grids.records
        SET data = jsonb_set(data, ${`{${fixture.statusId}}`}::text[], ${JSON.stringify("a".repeat(20_000))}::jsonb)
        WHERE id = ${fixture.orderBId}::uuid
      `;
      await sql`
        UPDATE grids.records
        SET data = jsonb_set(data, ${`{${fixture.statusId}}`}::text[], ${JSON.stringify("b".repeat(20_000))}::jsonb)
        WHERE id = ${fixture.orderAId}::uuid
      `;
      await sql`
        UPDATE grids.records
        SET data = jsonb_set(data, ${`{${fixture.statusId}}`}::text[], ${JSON.stringify("c".repeat(20_000))}::jsonb)
        WHERE id = ${fixture.orderCId}::uuid
      `;

      const source = `from table ${fixture.orders.shortId}\nsort STAT1x asc`;
      const first = await previewPage(fixture, source, { pageSize: 1 });
      const cursor = decodeDslResultCursor(first.page?.nextCursor, integrationCursorSigningKey);
      expect(cursor?.values).toBeNull();

      const second = await previewPage(fixture, source, { pageSize: 1, cursor });
      expect(second.rows).toHaveLength(1);
      expect(second.rows[0]?.recordId).toBe(fixture.orderAId);
      const secondCursor = decodeDslResultCursor(second.page?.nextCursor, integrationCursorSigningKey);
      expect(secondCursor?.values).toBeNull();

      const third = await previewPage(fixture, source, { pageSize: 1, cursor: secondCursor });
      expect(third.rows).toHaveLength(1);
      expect(third.rows[0]?.recordId).toBe(fixture.orderCId);
      expect(third.page?.nextCursor).toBeNull();
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("does not offer a next page when a source limit exceeds the matching rows", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const page = await previewPage(fixture, `from table ${fixture.orders.shortId}\nsort STAT1x asc\nlimit 100`, { pageSize: 100 });
      expect(page.rows).toHaveLength(3);
      expect(page.page?.nextCursor).toBeNull();
      expect(page.truncated).toBe(false);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("paginates joined rows without duplicates or omissions", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const source = `
        from table ${fixture.orders.shortId}
        join table ${fixture.customers.shortId} as customer on CUSTLx = customer.id
        select customer.NAME1x as customer_name, AMT01x as order_amount
        sort order_amount asc
      `;
      const recordIds: string[] = [];
      let cursor: ReturnType<typeof decodeDslResultCursor> = null;
      do {
        const page = await previewPage(fixture, source, { pageSize: 1, cursor });
        recordIds.push(...page.rows.flatMap((row) => (row.recordId ? [row.recordId] : [])));
        cursor = decodeDslResultCursor(page.page?.nextCursor, integrationCursorSigningKey);
      } while (cursor);

      expect(recordIds).toEqual([fixture.orderBId, fixture.orderAId]);
      expect(new Set(recordIds).size).toBe(recordIds.length);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes row formulas, relation joins, and joined sorting", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const result = await preview(
        fixture,
        `
          from table ${fixture.orders.shortId}
          join table ${fixture.customers.shortId} as customer on CUSTLx = customer.id
          select AMT01x as order_amount, customer.NAME1x as customer_label, formula(AMT01x - COST1x) as line_margin
          where AMT01x > COST1x
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

  postgresTest("executes scoped formula refs over joined records", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const rows = await preview(
        fixture,
        `
          from table ${fixture.orders.shortId}
          join table ${fixture.customers.shortId} as customer on CUSTLx = customer.id
          select formula(AMT01x + customer.SCOREx) as weighted
          where customer.SCOREx > 5
          sort weighted desc
        `,
      );

      expect(rows.mode).toBe("rows");
      expect(rows.rows.map((row) => row.recordId)).toEqual([fixture.orderAId]);
      expect(rows.rows[0]?.values.q_col_0).toBe("20.5");
      expect(Number(rows.rows[0]?.values.q_col_0)).toBe(20.5);

      const grouped = await preview(
        fixture,
        `
          from table ${fixture.orders.shortId}
          join table ${fixture.customers.shortId} as customer on CUSTLx = customer.id
          group by customer.NAME1x
          aggregate sum(formula(AMT01x + customer.SCOREx)) as weighted
          sort weighted desc
        `,
      );

      expect(grouped.mode).toBe("groups");
      expect(grouped.rows.map((row) => row.values.gk_0)).toEqual(["Alice", "Bob"]);
      expect(Number(grouped.rows[0]?.values.weighted__sum)).toBe(20.5);
      expect(Number(grouped.rows[1]?.values.weighted__sum)).toBe(7);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes joined lookup and rollup fields in row select, formula, and sort", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const result = await preview(
        fixture,
        `
          from table ${fixture.orders.shortId}
          join table ${fixture.customers.shortId} as customer on CUSTLx = customer.id
          select customer.FAMT1x as favorite_amount, formula(customer.FSUM1x + 1) as favorite_plus_one
          sort customer.FSUM1x desc
        `,
      );

      expect(result.mode).toBe("rows");
      expect(result.rows.map((row) => row.recordId)).toEqual([fixture.orderAId, fixture.orderBId]);
      expect(Number(result.rows[0]?.values.q_col_0)).toBe(12.5);
      expect(Number(result.rows[0]?.values.q_col_1)).toBe(13.5);
      expect(Number(result.rows[1]?.values.q_col_0)).toBe(4);
      expect(Number(result.rows[1]?.values.q_col_1)).toBe(5);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes a full-text search clause", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const all = await preview(fixture, `search 'Alice'`);
      expect(all.mode).toBe("rows");
      expect(all.rows.map((row) => row.recordId)).toEqual([fixture.orderAId]);

      const scoped = await preview(fixture, `search 'Closed' in STAT1x`);
      expect(scoped.rows.map((row) => row.recordId)).toEqual([fixture.orderBId]);

      const joined = await preview(
        fixture,
        `
          join table ${fixture.customers.shortId} as customer on CUSTLx = customer.id
          search 'Bob' in customer.NAME1x
        `,
      );
      expect(joined.rows.map((row) => row.recordId)).toEqual([fixture.orderBId]);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes explicit case-insensitive text predicates", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const contains = await preview(fixture, `where icontains(STAT1x, 'open')`);
      expect(contains.rows.map((row) => row.recordId)).toEqual([fixture.orderAId]);

      const startsWith = await preview(fixture, `where istartswith(STAT1x, 'clo')`);
      expect(startsWith.rows.map((row) => row.recordId)).toEqual([fixture.orderBId]);

      const endsWith = await preview(fixture, `where iendswith(STAT1x, 'LOG')`);
      expect(endsWith.rows.map((row) => row.recordId)).toEqual([fixture.orderCId]);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes scoped text predicates over joined records", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const contains = await preview(
        fixture,
        `
          join table ${fixture.customers.shortId} as customer on CUSTLx = customer.id
          where icontains(customer.NAME1x, 'AL')
        `,
      );
      expect(contains.rows.map((row) => row.recordId)).toEqual([fixture.orderAId]);

      const startsWith = await preview(
        fixture,
        `
          join table ${fixture.customers.shortId} as customer on CUSTLx = customer.id
          where istartswith(customer.NAME1x, 'bo')
        `,
      );
      expect(startsWith.rows.map((row) => row.recordId)).toEqual([fixture.orderBId]);

      const endsWith = await preview(
        fixture,
        `
          join table ${fixture.customers.shortId} as customer on CUSTLx = customer.id
          where iendswith(customer.NAME1x, 'ICE')
        `,
      );
      expect(endsWith.rows.map((row) => row.recordId)).toEqual([fixture.orderAId]);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });
});
