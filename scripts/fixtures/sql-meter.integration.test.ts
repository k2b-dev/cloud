import { expect } from "bun:test";
// A live binding: the meter rebinds this handle through itself and back.
import { sql } from "../../packages/cloud/src/runtime/clients";
import { meterSql } from "./sql-meter";
import { testFor } from "./test-infra";

testFor("database")("records each statement of the platform handle, transactions included, and nothing outside the window", async () => {
  const meter = await meterSql();
  try {
    await sql`SELECT 1`;
    const statements = await meter.during(async () => {
      await sql`SELECT ${1}::int AS one`;
      await sql`SELECT ${2}::int AS two`;
      await sql.begin(async (tx) => {
        await tx`SELECT 3`;
      });
    });
    expect(statements.map((statement) => statement.split(" ")[0]?.toUpperCase())).toEqual([
      "SELECT",
      "SELECT",
      "BEGIN",
      "SELECT",
      "COMMIT",
    ]);
    expect(statements[0]).toContain("AS one");
    expect(statements[1]).toContain("AS two");
    expect(await meter.during(async () => {})).toEqual([]);
  } finally {
    await meter.close();
  }
  // Closed: the platform handle reaches the database directly again.
  expect(await sql`SELECT 1 AS direct`).toHaveLength(1);
});
