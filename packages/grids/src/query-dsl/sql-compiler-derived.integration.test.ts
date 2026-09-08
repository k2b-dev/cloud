import { beforeAll, describe, expect } from "bun:test";
import { migrate } from "../migrate";
import { decodeDslResultCursor } from "./result-cursor";
import {
  cleanupFixture,
  ctx,
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

describe("Query DSL Postgres smoke — derived saved-view sources", () => {
  postgresTest("executes row-shaped view source filter, search, and scoped limit", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const topView = {
        kind: "view" as const,
        id: uuid(),
        shortId: "TOP1",
        name: "Top one order",
        tableId: fixture.orders.id,
        query: { sort: [{ fieldId: fixture.amountId, direction: "desc" as const }], limit: 1 },
      };
      const closedView = {
        kind: "view" as const,
        id: uuid(),
        shortId: "CLOS1",
        name: "Closed orders",
        tableId: fixture.orders.id,
        query: {
          filter: { fieldId: fixture.statusId, op: "equals" as const, value: "Closed" },
          sort: [{ fieldId: fixture.amountId, direction: "desc" as const }],
          limit: 1,
        },
      };
      const openSearchView = {
        kind: "view" as const,
        id: uuid(),
        shortId: "OPENS",
        name: "Open search",
        tableId: fixture.orders.id,
        query: { search: { q: "Open", fieldIds: [fixture.statusId] } },
      };
      const context = { ...ctx(fixture), views: [topView, closedView, openSearchView] };

      const scopedBeforeWhere = await preview(
        fixture,
        `
          from view TOP1
          select AMT01x as order_amount
          where STAT1x = 'Closed'
        `,
        context,
      );
      expect(scopedBeforeWhere.mode).toBe("rows");
      expect(scopedBeforeWhere.rows).toHaveLength(0);

      const filtered = await preview(fixture, `from view CLOS1\nselect AMT01x as order_amount`, context);
      expect(filtered.rows.map((row) => row.recordId)).toEqual([fixture.orderBId]);

      const searched = await preview(fixture, `from view OPENS\nsearch 'Closed' in STAT1x`, context);
      expect(searched.rows).toHaveLength(0);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes view source scoped limits before grouped and aggregate previews", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const topTwoView = {
        kind: "view" as const,
        id: uuid(),
        shortId: "TOP2",
        name: "Top two orders",
        tableId: fixture.orders.id,
        query: { sort: [{ fieldId: fixture.amountId, direction: "desc" as const }], limit: 2 },
      };
      const context = { ...ctx(fixture), views: [topTwoView] };

      const grouped = await preview(
        fixture,
        `
          from view TOP2
          group by STAT1x
          aggregate count(*) as rows
        `,
        context,
      );
      expect(grouped.mode).toBe("groups");
      const groupedStatuses = new Set(grouped.rows.map((row) => row.values.gk_0));
      expect(groupedStatuses).toEqual(new Set(["Closed", "Open"]));

      const aggregate = await preview(fixture, `from view TOP2\naggregate count(*) as rows, sum(AMT01x) as revenue`, context);
      expect(aggregate.mode).toBe("groups");
      expect(Number(aggregate.rows[0]?.values["*__count"])).toBe(2);
      expect(Number(aggregate.rows[0]?.values[`${fixture.amountId}__sum`])).toBe(16.5);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes grouped and aggregate saved views as derived sources", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const byStatusView = {
        kind: "view" as const,
        id: uuid(),
        shortId: "SUMRY",
        name: "Status summary",
        tableId: fixture.orders.id,
        query: {
          groupBy: [{ fieldId: fixture.statusId, direction: "asc" as const }],
          aggregations: [{ fieldId: fixture.amountId, agg: "sum" as const, label: "revenue" }],
          groupSort: [{ fieldId: fixture.amountId, agg: "sum" as const, direction: "desc" as const }],
        },
      };
      const totalsView = {
        kind: "view" as const,
        id: uuid(),
        shortId: "TOTAL",
        name: "Totals",
        tableId: fixture.orders.id,
        query: {
          aggregations: [
            { fieldId: "*", agg: "count" as const, label: "rows" },
            { fieldId: fixture.amountId, agg: "sum" as const, label: "revenue" },
          ],
        },
      };
      const context = { ...ctx(fixture), views: [byStatusView, totalsView] };

      const grouped = await preview(
        fixture,
        `
          from view SUMRY
          select Status, revenue
          where revenue > 5
          sort revenue desc
        `,
        context,
      );
      expect(grouped.mode).toBe("groups");
      expect(grouped.rows.map((row) => row.values.gk_0)).toEqual(["Open"]);
      expect(Number(grouped.rows[0]?.values[`${fixture.amountId}__sum`])).toBe(12.5);

      const pagedSource = `from view SUMRY\nselect Status, revenue\nsort revenue desc`;
      const statuses: unknown[] = [];
      let cursor: ReturnType<typeof decodeDslResultCursor> = null;
      do {
        const page = await previewPage(fixture, pagedSource, { pageSize: 1, cursor, context });
        statuses.push(...page.rows.map((row) => row.values.gk_0));
        cursor = decodeDslResultCursor(page.page?.nextCursor, integrationCursorSigningKey);
      } while (cursor);

      expect(statuses).toEqual(["Open", "Closed", "Backlog"]);
      expect(new Set(statuses).size).toBe(statuses.length);

      const differentlySortedSource = `from view SUMRY\nselect Status, revenue\nsort Status asc`;
      const sortedStatuses: unknown[] = [];
      cursor = null;
      do {
        const page = await previewPage(fixture, differentlySortedSource, { pageSize: 1, cursor, context });
        sortedStatuses.push(...page.rows.map((row) => row.values.gk_0));
        cursor = decodeDslResultCursor(page.page?.nextCursor, integrationCursorSigningKey);
      } while (cursor);

      expect(sortedStatuses).toEqual(["Backlog", "Closed", "Open"]);
      expect(new Set(sortedStatuses).size).toBe(sortedStatuses.length);

      const aggregate = await preview(fixture, `from view TOTAL\nselect rows, revenue\nwhere revenue > 10`, context);
      expect(aggregate.mode).toBe("groups");
      expect(Number(aggregate.rows[0]?.values["*__count"])).toBe(3);
      expect(Number(aggregate.rows[0]?.values[`${fixture.amountId}__sum`])).toBe(16.5);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes derived relation output joins", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const byCustomerView = {
        kind: "view" as const,
        id: uuid(),
        shortId: "BYCUS",
        name: "Revenue by customer",
        tableId: fixture.orders.id,
        query: {
          groupBy: [{ fieldId: fixture.customerLinkId, direction: "asc" as const }],
          aggregations: [{ fieldId: fixture.amountId, agg: "sum" as const, label: "revenue" }],
        },
      };
      const context = { ...ctx(fixture), views: [byCustomerView] };

      const result = await preview(
        fixture,
        `
          from view BYCUS
          join table ${fixture.customers.shortId} as customer on Customer = customer.id
          select Customer, revenue, customer.NAME1x as customer_name, customer.FAMT1x as favorite_amount
          sort customer.FSUM1x desc
        `,
        context,
      );

      expect(result.mode).toBe("groups");
      const joinedKey = result.columns.find((column) => column.label === "customer_name")?.key;
      expect(typeof joinedKey).toBe("string");
      expect(result.rows.map((row) => row.values.gk_0)).toEqual(["Alice", "Bob"]);
      expect(result.rows.map((row) => row.values[joinedKey!])).toEqual(["Alice", "Bob"]);
      expect(result.rows.map((row) => Number(row.values.q_col_3))).toEqual([12.5, 4]);
      const byCustomer = new Map(result.rows.map((row) => [row.values[joinedKey!], Number(row.values[`${fixture.amountId}__sum`])]));
      expect(byCustomer).toEqual(
        new Map([
          ["Alice", 12.5],
          ["Bob", 4],
        ]),
      );
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("searches derived relation group columns by visible labels", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const byCustomerView = {
        kind: "view" as const,
        id: uuid(),
        shortId: "BYCUS",
        name: "Revenue by customer",
        tableId: fixture.orders.id,
        query: {
          groupBy: [{ fieldId: fixture.customerLinkId, direction: "asc" as const }],
          aggregations: [{ fieldId: fixture.amountId, agg: "sum" as const, label: "revenue" }],
        },
      };
      const context = { ...ctx(fixture), views: [byCustomerView] };

      const byLabel = await preview(
        fixture,
        `
          from view BYCUS
          search 'Alice' in Customer
          select Customer, revenue
        `,
        context,
      );

      expect(byLabel.mode).toBe("groups");
      expect(byLabel.rows).toHaveLength(1);
      expect(byLabel.rows[0]?.values.gk_0).toBe("Alice");
      expect(Number(byLabel.rows[0]?.values[`${fixture.amountId}__sum`])).toBe(12.5);

      const byRawId = await preview(
        fixture,
        `
          from view BYCUS
          search '${fixture.customerAId.slice(0, 8)}' in Customer
          select Customer, revenue
        `,
        context,
      );

      expect(byRawId.mode).toBe("groups");
      expect(byRawId.rows).toHaveLength(0);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes joined predicates and regrouping over derived relation output joins", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const byCustomerView = {
        kind: "view" as const,
        id: uuid(),
        shortId: "BYCUS",
        name: "Revenue by customer",
        tableId: fixture.orders.id,
        query: {
          groupBy: [{ fieldId: fixture.customerLinkId, direction: "asc" as const }],
          aggregations: [{ fieldId: fixture.amountId, agg: "sum" as const, label: "revenue" }],
        },
      };
      const context = { ...ctx(fixture), views: [byCustomerView] };

      const result = await preview(
        fixture,
        `
          from view BYCUS
          join table ${fixture.customers.shortId} as customer on Customer = customer.id
          search 'Alice' in customer.NAME1x
          where customer.SCOREx > 5 and revenue > 1
          group by customer.NAME1x
          aggregate sum(revenue) as total_revenue, avg(customer.SCOREx) as avg_score, sum(formula(revenue + customer.SCOREx)) as weighted
          having total_revenue > 10
          sort total_revenue desc
        `,
        context,
      );

      expect(result.mode).toBe("groups");
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.values.gk_0).toBe("Alice");
      expect(Number(result.rows[0]?.values["*__count"])).toBe(1);
      expect(Number(result.rows[0]?.values[`${fixture.amountId}__sum__sum`])).toBe(12.5);
      expect(Number(result.rows[0]?.values[`${fixture.customerScoreId}__avg`])).toBe(8);
      expect(Number(result.rows[0]?.values.weighted__sum)).toBe(20.5);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes chained joins while regrouping derived relation output", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const byCustomerView = {
        kind: "view" as const,
        id: uuid(),
        shortId: "BYCUS",
        name: "Revenue by customer",
        tableId: fixture.orders.id,
        query: {
          groupBy: [{ fieldId: fixture.customerLinkId, direction: "asc" as const }],
          aggregations: [{ fieldId: fixture.amountId, agg: "sum" as const, label: "revenue" }],
        },
      };
      const context = { ...ctx(fixture), views: [byCustomerView] };

      const result = await preview(
        fixture,
        `
          from view BYCUS
          join table ${fixture.customers.shortId} as Customer on Customer = customer.id
          join table ${fixture.orders.shortId} as favorite on customer.FAVORx = favorite.id
          search 'Open' in favorite.STAT1x
          where favorite.AMT01x > 10 and revenue > 1
          group by favorite.STAT1x
          aggregate sum(revenue) as total_revenue, sum(formula(revenue + favorite.AMT01x)) as weighted
          sort total_revenue desc
        `,
        context,
      );

      expect(result.mode).toBe("groups");
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.values.gk_0).toBe("Open");
      expect(Number(result.rows[0]?.values["*__count"])).toBe(1);
      expect(Number(result.rows[0]?.values[`${fixture.amountId}__sum__sum`])).toBe(12.5);
      expect(Number(result.rows[0]?.values.weighted__sum)).toBe(25);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("executes search and re-aggregation over derived saved-view output", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const byStatusView = {
        kind: "view" as const,
        id: uuid(),
        shortId: "SUMRY",
        name: "Status summary",
        tableId: fixture.orders.id,
        query: {
          groupBy: [{ fieldId: fixture.statusId, direction: "asc" as const }],
          aggregations: [{ fieldId: fixture.amountId, agg: "sum" as const, label: "revenue" }],
        },
      };
      const context = { ...ctx(fixture), views: [byStatusView] };

      const searched = await preview(
        fixture,
        `
          from view SUMRY
          search 'Open' in Status
          select Status, revenue
        `,
        context,
      );
      expect(searched.mode).toBe("groups");
      expect(searched.rows.map((row) => row.values.gk_0)).toEqual(["Open"]);
      expect(Number(searched.rows[0]?.values[`${fixture.amountId}__sum`])).toBe(12.5);

      const regrouped = await preview(
        fixture,
        `
          from view SUMRY
          group by Status
          aggregate sum(revenue) as total_revenue, count(*) as rows
          having total_revenue > 10
          sort total_revenue desc
        `,
        context,
      );
      expect(regrouped.mode).toBe("groups");
      expect(regrouped.rows.map((row) => row.values.gk_0)).toEqual(["Open"]);
      expect(Number(regrouped.rows[0]?.values[`${fixture.amountId}__sum__sum`])).toBe(12.5);
      expect(Number(regrouped.rows[0]?.values["*__count"])).toBe(1);

      const rollup = await preview(fixture, `from view SUMRY\naggregate sum(revenue) as total_revenue, count(*) as buckets`, context);
      expect(rollup.mode).toBe("groups");
      expect(Number(rollup.rows[0]?.values[`${fixture.amountId}__sum__sum`])).toBe(16.5);
      expect(Number(rollup.rows[0]?.values["*__count"])).toBe(3);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("searches derived select group columns by option labels", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const byStageView = {
        kind: "view" as const,
        id: uuid(),
        shortId: "BYSTG",
        name: "Revenue by stage",
        tableId: fixture.orders.id,
        query: {
          groupBy: [{ fieldId: fixture.stageId, direction: "asc" as const }],
          aggregations: [{ fieldId: fixture.amountId, agg: "sum" as const, label: "revenue" }],
        },
      };
      const context = { ...ctx(fixture), views: [byStageView] };

      const byLabel = await preview(
        fixture,
        `
          from view BYSTG
          search 'On hold' in Stage
          select Stage, revenue
        `,
        context,
      );

      expect(byLabel.mode).toBe("groups");
      expect(byLabel.rows).toHaveLength(1);
      expect(byLabel.rows[0]?.values.gk_0).toBe("hold");

      const byRawId = await preview(
        fixture,
        `
          from view BYSTG
          search 'closed' in Stage
          select Stage, revenue
        `,
        context,
      );

      expect(byRawId.mode).toBe("groups");
      expect(byRawId.rows).toHaveLength(1);
      expect(byRawId.rows[0]?.values.gk_0).toBe("closed");
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("applies saved search before derived grouped view re-aggregation", async () => {
    const fixture = await insertDslDbFixture();
    try {
      const openStatusView = {
        kind: "view" as const,
        id: uuid(),
        shortId: "OPNSM",
        name: "Open status summary",
        tableId: fixture.orders.id,
        query: {
          search: { q: "Open", fieldIds: [fixture.statusId] },
          groupBy: [{ fieldId: fixture.statusId, direction: "asc" as const }],
          aggregations: [{ fieldId: fixture.amountId, agg: "sum" as const, label: "revenue" }],
        },
      };
      const context = { ...ctx(fixture), views: [openStatusView] };

      const rollup = await preview(
        fixture,
        `
          from view OPNSM
          aggregate sum(revenue) as total_revenue, count(*) as buckets
        `,
        context,
      );
      expect(rollup.mode).toBe("groups");
      expect(Number(rollup.rows[0]?.values[`${fixture.amountId}__sum__sum`])).toBe(12.5);
      expect(Number(rollup.rows[0]?.values["*__count"])).toBe(1);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });
});
