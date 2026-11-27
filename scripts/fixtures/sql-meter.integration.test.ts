import { expect } from "bun:test";
import type { SQL } from "bun";
// A live binding: the meter rebinds this handle through itself and back.
import { createSql, sql } from "../../packages/cloud/src/runtime/clients";
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

// #4494: a later meter or query must never reach a proxy port that has closed.
testFor("database")("opens and closes any number of meters in one process, and every handle queries after each", async () => {
  let lazy: SQL | undefined;
  try {
    for (let round = 0; round < 4; round++) {
      const meter = await meterSql();
      try {
        const statements = await meter.during(async () => {
          // A domain module's lazy pool, created while the meter is open.
          lazy ??= createSql({ max: 2 });
          await lazy`SELECT ${round}::int AS lazy`;
          await sql`SELECT ${round}::int AS platform`;
        });
        expect(statements).toHaveLength(2);
      } finally {
        await meter.close();
      }
      expect(await sql`SELECT ${round}::int AS direct`).toEqual([{ direct: round }]);
      // Two at once: the pool opens a new connection, not only its idle one.
      expect(await Promise.all([lazy!`SELECT 1 AS one`, lazy!`SELECT 2 AS two`])).toEqual([[{ one: 1 }], [{ two: 2 }]]);
    }
  } finally {
    await lazy?.close();
  }
});

testFor("database")("overlapping meters closed out of order leave the handle on the database", async () => {
  const first = await meterSql();
  const second = await meterSql();
  // A test that timed out closes its meter after the next test opened one.
  await first.close();
  expect(await second.during(() => sql`SELECT 1`)).toHaveLength(1);
  await second.close();
  await second.close();
  expect(await sql`SELECT 1 AS direct`).toEqual([{ direct: 1 }]);
  const third = await meterSql();
  try {
    expect(await third.during(() => sql`SELECT 1`)).toHaveLength(1);
  } finally {
    await third.close();
  }
  expect(await sql`SELECT 1 AS direct`).toEqual([{ direct: 1 }]);
});
