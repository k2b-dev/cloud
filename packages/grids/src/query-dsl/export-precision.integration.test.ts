import { beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { migrate } from "../migrate";
import { canonicalizeDslQuery } from "./canonical";
import { parseGridsQueryDsl } from "./parser";
import { cleanupFixture, ctx, insertDslDbFixture, postgresTest, preview } from "./sql-compiler.integration-fixtures";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

postgresTest("query export predicates and canonical calculations never round exact decimal literals", async () => {
  const fixture = await insertDslDbFixture();
  try {
    const amount = fixture.fieldsByTableId[fixture.orders.id]!.find((field) => field.name === "Amount")!;
    await sql`UPDATE grids.records SET data = data || ${{ [amount.id]: "9007199254740993.42" }}::jsonb WHERE id = ${fixture.orderAId}::uuid`;
    await sql`UPDATE grids.records SET data = data || ${{ [amount.id]: "9007199254740992.42" }}::jsonb WHERE id = ${fixture.orderBId}::uuid`;
    await sql`UPDATE grids.records SET data = data || ${{ [fixture.customerScoreId]: "9007199254740993.42" }}::jsonb WHERE id = ${fixture.customerAId}::uuid`;
    for (const source of [
      "from table Orders\nselect Amount as exported_amount\nwhere Amount = 9007199254740993.42",
      "from table Orders\nselect Amount as exported_amount\nwhere oneof(Amount, 9007199254740993.42)",
      "from table Orders\njoin table Customers as customer on Customer = customer.id\nselect Amount as exported_amount\nwhere oneof(customer.Score, 9007199254740993.42)",
    ]) {
      const parsed = parseGridsQueryDsl(source);
      if (!parsed.ok) throw new Error("invalid fixture source");
      const canonical = canonicalizeDslQuery(parsed.ast, ctx(fixture));
      if (!canonical.ok) throw new Error(JSON.stringify(canonical.diagnostics));
      const result = await preview(fixture, canonical.source);
      expect(result.rows.map((row) => row.recordId)).toEqual([fixture.orderAId]);
      expect(Object.values(result.rows[0]!.values)).toEqual(["9007199254740993.42"]);
    }
    const source = "from table Orders\nselect formula(9007199254740993.42 + 0.01) as total\nlimit 1";
    const parsed = parseGridsQueryDsl(source);
    if (!parsed.ok) throw new Error("invalid calculation fixture");
    const canonical = canonicalizeDslQuery(parsed.ast, ctx(fixture));
    if (!canonical.ok) throw new Error(JSON.stringify(canonical.diagnostics));
    expect(Object.values((await preview(fixture, canonical.source)).rows[0]!.values)).toEqual(["9007199254740993.43"]);
  } finally {
    await cleanupFixture(fixture.baseId);
  }
});
