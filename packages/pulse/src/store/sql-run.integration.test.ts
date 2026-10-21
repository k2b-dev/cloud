import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { clickhouseAdminQuery as admin } from "../../../../scripts/fixtures/test-clickhouse";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { createBaseLifecycle } from "../service/base-lifecycle";
import { READ_PROFILE_NAMES } from "./admin-contracts";
import { cleanupFixtureBase, fixtureBase, fixtureConnection, fixtureStore, installFixtureStore } from "./base-store.test-fixture";
import { clickhouseQuery } from "./client";
import { READ_PROFILES } from "./setup-sql";
import { createSqlRunner, sqlQueryId } from "./sql-run";
import { waitUntil } from "./sql-run.test-fixture";

const suite = suiteFor("database", "clickhouse");
const expensive = "SELECT sum(cityHash64(a.number,b.number)) FROM numbers(1000000) a CROSS JOIN numbers(1000000) b";
suite("SQL executes only through bounded read profiles", () => {
  beforeAll(installFixtureStore, 30000);
  test("exactly 10000 and 10001+ both return 10000 with limit-reached truncation; >4MiB fails", async () => {
    const base = await fixtureBase(),
      store = fixtureStore(),
      runner = createSqlRunner({ store, connection: async () => fixtureConnection() });
    try {
      await createBaseLifecycle(store)(base.id);
      const run = (query: string) =>
        runner.run({
          baseId: base.id,
          database: base.database,
          profile: "normal",
          timezone: "UTC",
          sql: query,
          runId: crypto.randomUUID(),
        });
      for (const size of [10000, 10001, 20000]) {
        const result = await run(`SELECT number FROM numbers(${size})`);
        expect(result.rowCount).toBe(10000);
        expect(result.truncated).toBe(true);
      }
      const small = await run("SELECT number FROM numbers(9999)");
      expect(small.truncated).toBe(false);
      await expect(run("SELECT materialize(repeat('x',5000)) FROM numbers(1000)")).rejects.toMatchObject({ code: "RESULT_TOO_LARGE" });
      // Constant columns bypass ClickHouse max_result_bytes; the Pulse byte cap still holds.
      await expect(run("SELECT repeat('x',5000) FROM numbers(1000)")).rejects.toMatchObject({ code: "RESULT_TOO_LARGE" });
    } finally {
      await cleanupFixtureBase(base);
    }
  }, 45000);
  test("typed values remain data and date instants survive offsets and the repeated DST hour", async () => {
    const base = await fixtureBase(),
      store = fixtureStore(),
      runner = createSqlRunner({ store, connection: async () => fixtureConnection() });
    try {
      await createBaseLifecycle(store)(base.id);
      const result = await runner.run({
        baseId: base.id,
        database: base.database,
        profile: "normal",
        timezone: "Europe/Berlin",
        runId: crypto.randomUUID(),
        sql: "SELECT :message AS message, toUnixTimestamp64Milli(:at) AS epoch, :bucket AS seconds, :number AS number, toString(:day) AS day, :base_tz AS timezone",
        params: { message: "'); DROP TABLE x; --", at: "2026-10-25T02:30:00+01:00", bucket: "2w", number: "-1.5", day: "2026-10-25" },
      });
      for (const message of ["tabs\tand\nlines\r", String.raw`backslash\n\t\N\x41`, "nul\0back\bform\f", "Grüße 😃", ""]) {
        const roundtrip = await runner.run({
          baseId: base.id,
          database: base.database,
          profile: "normal",
          timezone: "UTC",
          runId: crypto.randomUUID(),
          sql: "SELECT :message",
          params: { message },
        });
        expect(roundtrip.rows).toEqual([[message]]);
      }
      expect(result.rows[0]).toEqual([
        "'); DROP TABLE x; --",
        Date.parse("2026-10-25T01:30:00Z"),
        1209600,
        -1.5,
        "2026-10-25 00:00:00.000",
        "Europe/Berlin",
      ]);
    } finally {
      await cleanupFixtureBase(base);
    }
  });
  test("each profile enforces wall time, including sleepEachRow; memory maps separately", async () => {
    const base = await fixtureBase(),
      store = fixtureStore(),
      runner = createSqlRunner({ store, connection: async () => fixtureConnection() });
    try {
      await createBaseLifecycle(store)(base.id);
      for (const profile of READ_PROFILE_NAMES) {
        await sql`UPDATE pulse.base_stores SET profile=${profile},reconcile_needed=true WHERE base_id=${base.id}::uuid`;
        await createBaseLifecycle(store)(base.id);
        for (const query of [expensive, "SELECT sum(sleepEachRow(0.00001)) FROM numbers(10000000)"]) {
          const start = performance.now();
          await expect(
            runner.run({ baseId: base.id, database: base.database, profile, timezone: "UTC", sql: query, runId: crypto.randomUUID() }),
          ).rejects.toMatchObject({ code: "TIME_LIMIT" });
          expect(performance.now() - start).toBeLessThan(READ_PROFILES[`read_${profile}`].max_execution_time * 1000 + 3000);
        }
        await expect(
          runner.run({
            baseId: base.id,
            database: base.database,
            profile,
            timezone: "UTC",
            sql: "SELECT groupArray(repeat(toString(number),100)) FROM numbers(10000000)",
            runId: crypto.randomUUID(),
          }),
        ).rejects.toMatchObject({ code: "MEMORY_LIMIT" });
      }
    } finally {
      await cleanupFixtureBase(base);
    }
  }, 180000);
  test("abort removes server process; KILL filters both generated id and the actual base reader", async () => {
    const bases = [await fixtureBase(), await fixtureBase()],
      store = fixtureStore(),
      runner = createSqlRunner({ store, connection: async () => fixtureConnection() });
    try {
      for (const base of bases) await createBaseLifecycle(store)(base.id);
      const base = bases[0]!,
        other = bases[1]!,
        runId = crypto.randomUUID(),
        controller = new AbortController();
      const process = (id: string) =>
        admin("SELECT count() AS n FROM system.processes WHERE query_id={q:String}", { params: { q: id } }).then(
          (rows) => Number(rows[0]?.n) > 0,
        );
      const running = runner
        .run({
          baseId: base.id,
          database: base.database,
          profile: "normal",
          timezone: "UTC",
          sql: expensive,
          runId,
          signal: controller.signal,
        })
        .then(
          () => null,
          (error) => error,
        );
      await waitUntil(() => process(sqlQueryId(base.id, runId)));
      controller.abort();
      expect(await running).toMatchObject({ code: "CANCELLED" });
      await waitUntil(async () => !(await process(sqlQueryId(base.id, runId))));
      const craftedId = sqlQueryId(base.id, crypto.randomUUID()),
        otherAbort = new AbortController();
      const foreign = clickhouseQuery({
        ...fixtureConnection(),
        ...(await store.readUserCredentials(other.id)),
        query: expensive,
        queryId: craftedId,
        timeoutMs: 12000,
        signal: otherAbort.signal,
      }).catch(() => []);
      try {
        await waitUntil(() => process(craftedId));
        await runner.kill(base.id, craftedId.slice(craftedId.lastIndexOf("_") + 1));
        expect(await process(craftedId)).toBe(true);
      } finally {
        otherAbort.abort();
        await foreign;
      }
    } finally {
      for (const base of bases) await cleanupFixtureBase(base);
    }
  }, 45000);
});
