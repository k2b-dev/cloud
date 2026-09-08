import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { migrate } from "../migrate";
import { parseGridsQueryDsl } from "./parser";
import { previewDslQuery } from "./preview";
import { resolveDslQueryToQueryPlan } from "./resolver";
import { decodeDslResultCursor } from "./result-cursor";
import {
  cleanupFixture,
  ctx,
  insertDslDbFixture,
  integrationCursorSigningKey,
  postgresTest,
  uuid,
} from "./sql-compiler.integration-fixtures";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("GQL grouped execution page boundaries", () => {
  postgresTest(
    "keeps lookahead for grouped, joined, derived and regrouped pages",
    async () => {
      const fixture = await insertDslDbFixture();
      try {
        await sql`INSERT INTO grids.records (id, short_id, table_id, data)
        SELECT gen_random_uuid(), candidate.short_id, ${fixture.orders.id}::uuid,
          jsonb_build_object(${fixture.statusId}::text, candidate.short_id, ${fixture.amountId}::text, 123456)
        FROM (
          SELECT 'G' || lpad(n::text, 5, '0') AS short_id FROM generate_series(1, 20000) n
        ) candidate
        WHERE NOT EXISTS (SELECT 1 FROM grids.records existing WHERE existing.short_id = candidate.short_id)
        LIMIT 10001`;
        const context = {
          ...ctx(fixture),
          views: [
            {
              kind: "view" as const,
              id: uuid(),
              shortId: "SUMRYx",
              name: "Summary",
              tableId: fixture.orders.id,
              query: {
                filter: { fieldId: fixture.amountId, op: "=" as const, value: 123456 },
                groupBy: [{ fieldId: fixture.statusId, direction: "asc" as const }],
                aggregations: [{ fieldId: fixture.amountId, agg: "sum" as const, label: "revenue" }],
                limit: 10000,
              },
            },
          ],
        };
        const sources = [
          "from table Orders\nwhere Amount = 123456\ngroup by Status\naggregate count(*) as rows",
          "from table Orders\nleft join table Customers as customer on Customer = customer.id\nwhere Amount = 123456\ngroup by Status\naggregate count(*) as rows",
          "from view SUMRYx\nselect Status, revenue",
          "from view SUMRYx\ngroup by Status\naggregate sum(revenue) as total",
        ];
        for (const [index, source] of sources.entries()) {
          const parsed = parseGridsQueryDsl(source);
          if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
          const resolved = resolveDslQueryToQueryPlan(parsed.ast, context);
          if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
          for (const pageSize of [1000, 10000]) {
            const options = {
              fieldsByTableId: fixture.fieldsByTableId,
              limit: pageSize,
              maxRows: 10000,
              cursorFingerprint: `group-page-${index}`,
              cursorSigningKey: integrationCursorSigningKey,
            };
            const first = await previewDslQuery(resolved.plan, options);
            if (!first.ok) throw new Error(first.error.message);
            expect(first.data.rows).toHaveLength(pageSize);
            const expectMore = index < 2 || pageSize === 1000;
            expect(first.data.truncated).toBe(expectMore);
            const cursor = decodeDslResultCursor(first.data.page?.nextCursor, integrationCursorSigningKey);
            if (!expectMore) {
              expect(cursor).toBeNull();
              continue;
            }
            expect(cursor).not.toBeNull();
            const second = await previewDslQuery(resolved.plan, { ...options, cursor });
            if (!second.ok) throw new Error(second.error.message);
            if (!cursor) throw new Error("Missing continuation");
            const offsetPage = await previewDslQuery(resolved.plan, { ...options, cursor: { ...cursor, values: null } });
            if (!offsetPage.ok) throw new Error(offsetPage.error.message);
            expect(offsetPage.data.rows).toEqual(second.data.rows);
            expect(second.data.rows).toHaveLength(pageSize === 10000 ? 1 : 1000);
            const firstKeys = new Set(first.data.rows.map((row) => row.values.gk_0));
            expect(second.data.rows.some((row) => firstKeys.has(row.values.gk_0))).toBe(false);
          }
        }
        // An implicit inner limit must not cut a saved grouped source to 100.
        const { limit: _limit, ...unlimitedQuery } = context.views[0]!.query;
        const parsed = parseGridsQueryDsl("from view SUMRYx\naggregate sum(revenue) as total");
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const resolved = resolveDslQueryToQueryPlan(parsed.ast, { ...context, views: [{ ...context.views[0]!, query: unlimitedQuery }] });
        if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
        const total = await previewDslQuery(resolved.plan, { fieldsByTableId: fixture.fieldsByTableId });
        if (!total.ok) throw new Error(total.error.message);
        expect(Object.values(total.data.rows[0]!.values)).toContain(String(10001 * 123456));
      } finally {
        await cleanupFixture(fixture.baseId);
      }
    },
    20_000,
  );
});
