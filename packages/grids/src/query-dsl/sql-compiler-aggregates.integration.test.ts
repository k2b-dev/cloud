import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { migrate } from "../migrate";
import type { ExpansionViewer } from "../service/relations";
import { decodeDslResultCursor } from "./result-cursor";
import {
  cleanupFixture,
  ctx,
  field,
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

describe("Query DSL Postgres smoke — computed, labels, and aggregates", () => {
  postgresTest(
    "releases preview transactions after concurrent queries",
    async () => {
      const fixture = await insertDslDbFixture();
      try {
        const source = `
          group by STAT1x
          aggregate count(*) as rows, sum(AMT01x) as revenue
          sort STAT1x asc
        `;
        const results = await Promise.all(Array.from({ length: 16 }, () => preview(fixture, source)));

        expect(results).toHaveLength(16);
        expect(results.every((result) => result.mode === "groups" && result.rows.length === 3)).toBe(true);

        const followUp = await preview(fixture, "sort AMT01x asc");
        expect(followUp.mode).toBe("rows");
        expect(followUp.rows).toHaveLength(3);
      } finally {
        await cleanupFixture(fixture.baseId);
      }
    },
    15_000,
  );

  postgresTest("paginates grouped results without duplicate buckets", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const source = `from table ${fixture.orders.shortId}\ngroup by STAT1x\naggregate count(*) as rows\nsort STAT1x asc`;
      const first = await previewPage(fixture, source, { pageSize: 1 });
      const cursor = decodeDslResultCursor(first.page?.nextCursor, integrationCursorSigningKey);
      expect(cursor).not.toBeNull();
      const second = await previewPage(fixture, source, { pageSize: 1, cursor });
      expect(first.rows).toHaveLength(1);
      expect(second.rows).toHaveLength(1);
      expect(second.rows[0]?.values.gk_0).not.toBe(first.rows[0]?.values.gk_0);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes date buckets and grouped aggregate variants", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const result = await preview(
        fixture,
        `
          group by DATE1x by month
          aggregate count(*) as rows, median(AMT01x) as middle, earliest(DATE1x) as first_order, latest(DATE1x) as last_order
        `,
      );

      expect(result.mode).toBe("groups");
      const byMonth = new Map(result.rows.map((row) => [String(row.values.gk_0).slice(0, 7), row.values]));
      expect(Number(byMonth.get("2026-01")?.["*__count"])).toBe(1);
      expect(Number(byMonth.get("2026-01")?.[`${fixture.amountId}__median`])).toBe(12.5);
      expect(Number(byMonth.get("2026-02")?.["*__count"])).toBe(2);
      expect(String(byMonth.get("2026-02")?.[`${fixture.orderedAtId}__earliest`])).toStartWith("2026-02-03");
      expect(String(byMonth.get("2026-02")?.[`${fixture.orderedAtId}__latest`])).toStartWith("2026-02-20");
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("preserves explicit null ordering for group keys and aggregate aliases", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const groupKey = await preview(
        fixture,
        `
          group by AMT01x
          aggregate count(*) as rows
          sort AMT01x asc nulls first
        `,
      );
      expect(groupKey.rows.map((row) => row.values.gk_0)).toEqual([null, "4", "12.5"]);

      const aggregateAlias = await preview(
        fixture,
        `
          group by STAT1x
          aggregate sum(AMT01x) as revenue
          sort revenue asc nulls first
        `,
      );
      expect(aggregateAlias.rows.map((row) => row.values.gk_0)).toEqual(["Backlog", "Closed", "Open"]);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes multi-select grouped explode semantics", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const result = await preview(
        fixture,
        `
          group by TAGS1x
          aggregate count(*) as rows
        `,
      );

      expect(result.mode).toBe("groups");
      expect(result.explode).toBe(true);
      const byTag = new Map(result.rows.map((row) => [row.values.gk_0, row.values["*__count"]]));
      expect(Number(byTag.get("priority"))).toBe(2);
      expect(Number(byTag.get("remote"))).toBe(2);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("labels relation preview values and surfaces truncation", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const rows = await preview(
        fixture,
        `
          select CUSTLx as customer_label, PARNTx as parent_label
          sort AMT01x asc
        `,
        ctx(fixture),
        1,
      );

      expect(rows.mode).toBe("rows");
      expect(rows.limit).toBe(1);
      expect(rows.truncated).toBe(true);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.recordId).toBe(fixture.orderBId);
      expect(rows.rows[0]?.values.q_col_0).toEqual(["Bob"]);
      expect(rows.rows[0]?.values.q_col_1).toEqual(["Open"]);

      const grouped = await preview(
        fixture,
        `
          group by CUSTLx
          aggregate count(*) as rows
        `,
      );
      expect(grouped.mode).toBe("groups");
      expect(grouped.explode).toBe(true);
      expect(new Set(grouped.rows.map((row) => row.values.gk_0))).toEqual(new Set(["Alice", "Bob"]));
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("gates relation labels and relation search by viewer target-table access", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const blockedViewer: ExpansionViewer = { userId: uuid(), userGroups: [] };
      const adminViewer: ExpansionViewer = { userId: uuid(), userGroups: [], isAdmin: true };

      const visibleLabels = await preview(
        fixture,
        `
          select CUSTLx as customer_label
          sort AMT01x asc
        `,
        ctx(fixture),
        2,
        adminViewer,
      );
      expect(visibleLabels.mode).toBe("rows");
      expect(visibleLabels.rows.map((row) => row.values.q_col_0)).toEqual([["Bob"], ["Alice"]]);

      const blockedLabels = await preview(
        fixture,
        `
          select CUSTLx as customer_label
          sort AMT01x asc
        `,
        ctx(fixture),
        2,
        blockedViewer,
      );
      expect(blockedLabels.mode).toBe("rows");
      expect(blockedLabels.rows.map((row) => row.values.q_col_0)).toEqual([["Unknown record"], ["Unknown record"]]);

      const visibleSearch = await preview(fixture, `search 'Alice' in CUSTLx`, ctx(fixture), 10, adminViewer);
      expect(visibleSearch.mode).toBe("rows");
      expect(visibleSearch.rows.map((row) => row.recordId)).toEqual([fixture.orderAId]);

      const blockedSearch = await preview(fixture, `search 'Alice' in CUSTLx`, ctx(fixture), 10, blockedViewer);
      expect(blockedSearch.mode).toBe("rows");
      expect(blockedSearch.rows).toHaveLength(0);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes lookup/rollup computed projections through the real computed SQL map", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const rows = await preview(
        fixture,
        `
          select CSCORx as score, formula(CSCORx + AMT01x) as adjusted
          where CSCORx > 5
        `,
      );

      expect(rows.mode).toBe("rows");
      expect(rows.rows.map((row) => row.recordId)).toEqual([fixture.orderAId]);
      expect(Number(rows.rows[0]?.values.q_col_0)).toBe(8);
      expect(Number(rows.rows[0]?.values.q_col_1)).toBe(20.5);

      const aggregate = await preview(fixture, `aggregate sum(formula(CSCORx + AMT01x)) as adjusted_total`);
      expect(aggregate.mode).toBe("groups");
      expect(Number(aggregate.rows[0]?.values.adjusted_total__sum)).toBe(27.5);

      const directAggregate = await preview(fixture, `aggregate sum(CSCORx) as score_total`);
      expect(directAggregate.mode).toBe("groups");
      expect(Number(directAggregate.rows[0]?.values.score_total__sum)).toBe(11);

      const groupedDirectAggregate = await preview(
        fixture,
        `
          group by STAT1x
          aggregate sum(CSCORx) as score_total
          sort score_total desc
        `,
      );
      expect(groupedDirectAggregate.mode).toBe("groups");
      const byStatus = new Map(groupedDirectAggregate.rows.map((row) => [row.values.gk_0, Number(row.values.score_total__sum)]));
      expect(byStatus.get("Open")).toBe(8);
      expect(byStatus.get("Closed")).toBe(3);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes grouped formula aggregates with having", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const result = await preview(
        fixture,
        `
          from table ${fixture.orders.shortId}
          group by STAT1x
          aggregate sum(formula(AMT01x - COST1x)) as margin
          having margin > 5
        `,
      );

      expect(result.mode).toBe("groups");
      expect(result.rows).toHaveLength(1);
      expect(result.columns.find((column) => column.label === "margin")?.aggregate).toBe("sum");
      expect(result.rows[0]?.values.gk_0).toBe("Open");
      expect(Number(result.rows[0]?.values.margin__sum)).toBe(7.5);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes a relation = filter via record-link containment", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const [customer] = await sql<{ short_id: string }[]>`SELECT short_id FROM grids.records WHERE id = ${fixture.customerAId}::uuid`;
      const linked = await preview(fixture, `where CUSTLx = '${customer!.short_id}'`);
      expect(linked.mode).toBe("rows");
      expect(linked.rows.map((row) => row.recordId)).toEqual([fixture.orderAId]);

      const excluded = await preview(fixture, `where CUSTLx != '${customer!.short_id}'`);
      expect(excluded.rows.map((row) => row.recordId)).toEqual([fixture.orderBId, fixture.orderCId]);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes a mixed filter + cross-field formula predicate in one SQL pass", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const result = await preview(fixture, `where Status = 'Open' and AMT01x > COST1x`);
      expect(result.mode).toBe("rows");
      expect(result.rows.map((row) => row.recordId)).toEqual([fixture.orderAId]);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes a negated predicate", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const result = await preview(fixture, `where not (Status = 'Open')`);
      expect(result.mode).toBe("rows");
      expect(result.rows.map((row) => row.recordId)).toEqual([fixture.orderBId, fixture.orderCId]);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes aggregate-only formula predicates and aggregate output", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const result = await preview(
        fixture,
        `
          from table ${fixture.orders.shortId}
          where AMT01x > COST1x
          aggregate count(*) as rows, sum(AMT01x) as revenue
        `,
      );

      expect(result.mode).toBe("groups");
      expect(result.rows).toHaveLength(1);
      expect(Number(result.rows[0]?.values["*__count"])).toBe(1);
      expect(Number(result.rows[0]?.values[`${fixture.amountId}__sum`])).toBe(12.5);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes aggregate-only relation joins", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const result = await preview(
        fixture,
        `
          from table ${fixture.orders.shortId}
          join table ${fixture.customers.shortId} as customer on CUSTLx = customer.id
          aggregate sum(customer.SCOREx) as total_score, avg(customer.FAMT1x) as favorite_avg, sum(formula(AMT01x + customer.SCOREx)) as weighted
        `,
      );

      expect(result.mode).toBe("groups");
      expect(result.rows).toHaveLength(1);
      expect(Number(result.rows[0]?.values[`${fixture.customerScoreId}__sum`])).toBe(11);
      expect(Number(result.rows[0]?.values.favorite_avg__avg)).toBe(8.25);
      expect(Number(result.rows[0]?.values.weighted__sum)).toBe(27.5);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes aggregate-only counts over system columns", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const createdAtField = field({
        id: uuid(),
        shortId: "CRTAT",
        tableId: fixture.orders.id,
        name: "Created at",
        type: "created_at",
        position: 99,
      });
      const createdByField = field({
        id: uuid(),
        shortId: "CRTBY",
        tableId: fixture.orders.id,
        name: "Created by",
        type: "created_by",
        position: 100,
      });
      const context = {
        ...ctx(fixture),
        fieldsByTableId: {
          ...fixture.fieldsByTableId,
          [fixture.orders.id]: [...fixture.fieldsByTableId[fixture.orders.id]!, createdAtField, createdByField],
        },
      };

      const result = await preview(
        fixture,
        `
          from table ${fixture.orders.shortId}
          aggregate count(CRTAT) as created_rows, countEmpty(CRTBY) as missing_creator
        `,
        context,
      );

      expect(result.mode).toBe("groups");
      expect(result.rows).toHaveLength(1);
      expect(Number(result.rows[0]?.values[`${createdAtField.id}__count`])).toBe(3);
      expect(Number(result.rows[0]?.values[`${createdByField.id}__countEmpty`])).toBe(3);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });
});
