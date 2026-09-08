import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { parseGridsQueryDsl } from "./parser";
import { previewDslQuery } from "./preview";
import { resolveDslQueryToQueryPlan } from "./resolver";
import { cleanupFixture, field } from "./sql-compiler.integration-fixtures";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

const insertFixture = async () => {
  const baseId = testUuid();
  const orders = { kind: "table" as const, id: testUuid(), shortId: testShortId("O"), name: "Orders" };
  const customers = { kind: "table" as const, id: testUuid(), shortId: testShortId("C"), name: "Customers" };
  const amount = field({ id: testUuid(), tableId: orders.id, shortId: testShortId("A"), name: "Amount", type: "text" });
  const customer = field({
    id: testUuid(),
    tableId: orders.id,
    shortId: testShortId("F"),
    name: "Customer",
    type: "relation",
    config: { targetTableId: customers.id },
    position: 1,
  });
  const name = field({ id: testUuid(), tableId: customers.id, shortId: testShortId("N"), name: "Name", type: "text" });
  const fieldsByTableId = { [orders.id]: [amount, customer], [customers.id]: [name] };
  // Roll back all setup if any constraint fails before a fixture can be returned.
  await sql.begin(async (tx) => {
    await tx`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Query authorization')`;
    for (const [position, table] of [orders, customers].entries()) {
      await tx`INSERT INTO grids.tables (id, short_id, base_id, name, position)
        VALUES (${table.id}::uuid, ${table.shortId}, ${baseId}::uuid, ${table.name}, ${position})`;
    }
    for (const item of [amount, customer, name]) {
      await tx`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${item.id}::uuid, ${item.shortId}, ${item.tableId}::uuid, ${item.name}, ${item.type}, ${item.config}::jsonb, ${item.position})`;
    }
    const customerId = testUuid();
    await tx`INSERT INTO grids.records (id, short_id, table_id, data)
      VALUES (${customerId}::uuid, ${testShortId("R")}, ${customers.id}::uuid, ${{ [name.id]: "Alice" }}::jsonb)`;
    for (const value of ["one", "two", "three"]) {
      const recordId = testUuid();
      await tx`INSERT INTO grids.records (id, short_id, table_id, data)
        VALUES (${recordId}::uuid, ${testShortId("R")}, ${orders.id}::uuid, ${{ [amount.id]: value }}::jsonb)`;
      await tx`INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position)
        VALUES (${recordId}::uuid, ${customer.id}::uuid, ${customerId}::uuid, 0)`;
    }
  });
  return { baseId, orders, customers, fieldsByTableId };
};

type Fixture = Awaited<ReturnType<typeof insertFixture>>;
type Authorization = Pick<Parameters<typeof previewDslQuery>[1], "authorizedTableIds" | "primaryTableAuthorized">;

const execute = async (fixture: Fixture, source: string, authorization: Authorization) => {
  const parsed = parseGridsQueryDsl(source);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const resolved = resolveDslQueryToQueryPlan(parsed.ast, {
    currentTable: fixture.orders,
    tables: [fixture.orders, fixture.customers],
    views: [],
    fieldsByTableId: fixture.fieldsByTableId,
  });
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
  const result = await previewDslQuery(resolved.plan, {
    fieldsByTableId: fixture.fieldsByTableId,
    cursorFingerprint: fixture.baseId,
    limit: 10,
    labelRelationValues: false,
    ...authorization,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.data.rows;
};

describe("GQL source authorization", () => {
  postgresTest("separates trusted omission, table grants and explicit primary denial", async () => {
    const fixture = await insertFixture();
    try {
      // The same query fingerprint must not coalesce reads with different grants.
      const rows = await Promise.all([
        execute(fixture, "select Amount", {}),
        execute(fixture, "select Amount", { authorizedTableIds: new Set([fixture.orders.id]) }),
        execute(fixture, "select Amount", { authorizedTableIds: new Set() }),
        execute(fixture, "select Amount", {
          authorizedTableIds: new Set([fixture.orders.id]),
          primaryTableAuthorized: false,
        }),
        execute(fixture, "select Amount", { primaryTableAuthorized: false }),
        execute(fixture, "select Amount", { authorizedTableIds: new Set(), primaryTableAuthorized: true }),
      ]);
      expect(rows.map((result) => result.length)).toEqual([3, 3, 0, 0, 0, 3]);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("a primary grant never authorizes a missing joined source", async () => {
    const fixture = await insertFixture();
    try {
      const source = "join table Customers as customer on Customer = customer.id\nselect customer.Name";
      const [allowed, denied] = await Promise.all([
        execute(fixture, source, {
          authorizedTableIds: new Set([fixture.orders.id, fixture.customers.id]),
          primaryTableAuthorized: true,
        }),
        execute(fixture, source, {
          authorizedTableIds: new Set([fixture.orders.id]),
          primaryTableAuthorized: true,
        }),
      ]);
      expect(allowed.length).toBeGreaterThan(0);
      expect(denied).toEqual([]);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });
});
