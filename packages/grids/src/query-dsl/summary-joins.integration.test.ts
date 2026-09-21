import { beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { hydrateDslViewQueries } from "../service/gql-resolver-context";
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
  preview,
  previewPage,
  uuid,
} from "./sql-compiler.integration-fixtures";

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

for (const formula of [false, true]) {
  postgresTest(
    `independent summaries preserve equal-valued children, filters, no-child rows and pagination without fanout (formula: ${formula})`,
    async () => {
      const f = await insertDslDbFixture();
      try {
        // Four child records, two equal values in each independent filtered set.
        for (const [index, status] of ["Payment", "Payment", "Credit", "Credit"].entries()) {
          const id = uuid();
          await sql`INSERT INTO grids.records (id, short_id, table_id, data)
        VALUES (${id}::uuid, ${`SUM00${index}`}, ${f.orders.id}::uuid,
        ${{ [f.amountId]: status === "Payment" ? "1.10" : "0.20", [f.statusId]: status }}::jsonb)`;
          await sql`INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position)
        VALUES (${id}::uuid, ${f.customerLinkId}::uuid, ${f.customerAId}::uuid, 0)`;
        }
        const views = hydrateDslViewQueries({
          ...ctx(f),
          views: ["Payment", "Credit"].map((status) => ({
            kind: "view" as const,
            id: uuid(),
            shortId: status,
            name: status,
            tableId: f.orders.id,
            source: `from table Orders\nwhere Status = '${status}'\ngroup by Customer\naggregate sum(${formula ? "formula(Amount * 2)" : "Amount"}) as total`,
            query: {},
          })),
        });
        expect(views).toHaveLength(2);
        const context = { ...ctx(f), views };
        const source = `from table Customers as parent
      left join view Payment as paid on paid.Customer = parent.id
      left join view Credit as credit on credit.Customer = parent.id
      select Name, paid.total as paid_amount, credit.total as corrected, formula(SCOREx - IF(ISBLANK(paid.total), 0, paid.total) - IF(ISBLANK(credit.total), 0, credit.total)) as outstanding
      sort Name asc`;
        const result = await preview(f, source, context);
        const values = result.rows.map((row) => Object.fromEntries(result.columns.map((col) => [col.label, row.values[col.key]])));
        expect(values).toEqual([
          { Name: "Alice", paid_amount: formula ? "4.4" : "2.2", corrected: formula ? "0.8" : "0.4", outstanding: formula ? "2.8" : "5.4" },
          { Name: "Bob", paid_amount: null, corrected: null, outstanding: "3" },
        ]);
        const filtered = await preview(f, source.replace("sort Name asc", "where paid.total > 2\nsort Name asc"), context);
        expect(filtered.rows.map((row) => row.recordId)).toEqual([f.customerAId]);
        const first = await previewPage(f, source, { pageSize: 1, context });
        expect(first.rows).toHaveLength(1);
        expect(first.rows[0]?.recordId).toBe(f.customerAId);
        const sorted = await preview(f, source.replace("sort Name asc", "sort paid.total desc nulls last"), context);
        expect(sorted.rows.map((row) => row.recordId)).toEqual([f.customerAId, f.customerBId]);
        // Follow the signed cursor across a decimal summary value into a missing
        // group, rather than only proving that the first page can be rendered.
        const sortedSource = source.replace("sort Name asc", "sort paid.total desc nulls last");
        const sortedFirst = await previewPage(f, sortedSource, { pageSize: 1, context });
        const cursor = decodeDslResultCursor(sortedFirst.page?.nextCursor, integrationCursorSigningKey);
        expect(cursor).not.toBeNull();
        const sortedSecond = await previewPage(f, sortedSource, { pageSize: 1, context, cursor });
        expect([...sortedFirst.rows, ...sortedSecond.rows].map((row) => row.recordId)).toEqual([f.customerAId, f.customerBId]);
        expect(sortedSecond.page?.nextCursor).toBeNull();
        const parsed = parseGridsQueryDsl(source);
        if (!parsed.ok) throw new Error("fixture must parse");
        const resolved = resolveDslQueryToQueryPlan(parsed.ast, context);
        if (!resolved.ok) throw new Error("fixture must resolve");
        const denied = await previewDslQuery(resolved.plan, {
          fieldsByTableId: context.fieldsByTableId,
          authorizedTableIds: new Set([f.customers.id]),
          primaryTableAuthorized: true,
        });
        expect(denied.ok).toBe(false);
        if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");
        // Bob now has exactly the same paid summary as Alice. Neither aggregate
        // value nor child count can distinguish them; pagination must use the UUID.
        const tiedChild = uuid();
        await sql`INSERT INTO grids.records (id, short_id, table_id, data)
      VALUES (${tiedChild}::uuid, 'SUMtie', ${f.orders.id}::uuid,
        ${{ [f.amountId]: "2.20", [f.statusId]: "Payment" }}::jsonb)`;
        await sql`INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position)
      VALUES (${tiedChild}::uuid, ${f.customerLinkId}::uuid, ${f.customerBId}::uuid, 0)`;
        for (const direction of ["asc", "desc"]) {
          const tiedSource = source.replace("sort Name asc", `sort paid.total ${direction}`);
          const expected = [f.customerAId, f.customerBId].sort();
          if (direction === "desc") expected.reverse();
          const page1 = await previewPage(f, tiedSource, { pageSize: 1, context });
          const next = decodeDslResultCursor(page1.page?.nextCursor, integrationCursorSigningKey);
          expect(next).not.toBeNull();
          const page2 = await previewPage(f, tiedSource, { pageSize: 1, context, cursor: next });
          expect([...page1.rows, ...page2.rows].map((row) => row.recordId)).toEqual(expected);
          expect(page2.page?.nextCursor).toBeNull();
        }
      } finally {
        await cleanupFixture(f.baseId);
      }
    },
  );
}
