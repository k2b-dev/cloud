import { beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { installFixtureStore } from "../store/base-store.test-fixture";
import { assertWrite, writeFixture } from "./write.test-fixture";

/** Holds every event insert until `writers` inserts run at the same time, or until `limitMs` passes. */
const gateEventInserts = (store: Awaited<ReturnType<typeof writeFixture>>["store"], writers: number, limitMs: number) => {
  const query = store.query;
  let inFlight = 0;
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const seen = { peak: 0 };
  store.query = async (statement, params, connection) => {
    if (!/^INSERT INTO \S+\._events /.test(statement)) return query(statement, params, connection);
    seen.peak = Math.max(seen.peak, ++inFlight);
    if (inFlight === writers) open();
    try {
      await Promise.race([gate, Bun.sleep(limitMs)]);
      return await query(statement, params, connection);
    } finally {
      inFlight--;
    }
  };
  return seen;
};

suiteFor(
  "database",
  "valkey",
  "clickhouse",
)("Pulse ingest source lock (#4031)", () => {
  beforeAll(installFixtureStore, 30000);

  test("concurrent ingests to one source reach the store together instead of queuing behind each other's insert", async () => {
    const f = await writeFixture("source-lock-concurrency");
    const writers = 4,
      limitMs = 8_000;
    try {
      // A store insert that waits for the other writers stands for a slow ClickHouse. Under an exclusive source
      // lock only one insert can wait at a time, so the gate never opens and each writer waits the full limit.
      const seen = gateEventInserts(f.store, writers, limitMs);
      const started = performance.now();
      const results = await Promise.all(
        Array.from({ length: writers }, (_, i) => f.write({ events: [{ kind: "visit", value: i }] }, `burst-${i}`)),
      );
      const elapsed = performance.now() - started;
      for (const result of results) expect(assertWrite(result)).toEqual({ metrics: 0, events: 1, states: 0 });
      expect(seen.peak).toBe(writers);
      expect(elapsed).toBeLessThan(limitMs);
      // Nothing is lost or written twice, and every reservation completes.
      expect(await f.read("events", "toInt64(value) AS value", "ORDER BY value")).toEqual(
        Array.from({ length: writers }, (_, i) => ({ value: i })),
      );
      expect(
        await sql<
          { state: string; n: number }[]
        >`SELECT state,count(*)::int AS n FROM pulse.ingest_idempotency WHERE source_id=${f.sourceId}::uuid GROUP BY state`,
      ).toEqual([{ state: "done", n: writers }]);
      const [source] = await sql<{ last_seen_at: Date | null }[]>`SELECT last_seen_at FROM pulse.sources WHERE id=${f.sourceId}::uuid`;
      expect(source?.last_seen_at).not.toBeNull();
    } finally {
      await f.cleanup();
    }
  }, 60000);

  test("a retry with the same key while the first attempt still writes stores the batch once", async () => {
    const f = await writeFixture("source-lock-retry");
    try {
      gateEventInserts(f.store, 2, 8_000);
      const batch = { events: [{ kind: "checkout", value: 7 }] };
      const [first, retry] = await Promise.all([f.write(batch, "same-key"), f.write(batch, "same-key")]);
      expect(assertWrite(first)).toEqual({ metrics: 0, events: 1, states: 0 });
      expect(assertWrite(retry)).toEqual({ metrics: 0, events: 1, states: 0 });
      expect(await f.read("events", "id,toInt64(value) AS value")).toHaveLength(1);
      expect(await sql<{ state: string }[]>`SELECT state FROM pulse.ingest_idempotency WHERE source_id=${f.sourceId}::uuid`).toEqual([
        { state: "done" },
      ]);
    } finally {
      await f.cleanup();
    }
  }, 60000);

  test("one keyed event costs a fixed statement budget and takes the exclusive source lock twice, never around the insert", async () => {
    const f = await writeFixture("source-lock-statements");
    try {
      assertWrite(await f.write({ events: [{ kind: "warm" }] }, "warm-up"));
      // A marker statement records where the store insert happens between the metered SQL statements.
      const marker = "SELECT 'store insert' AS marker";
      const query = f.store.query;
      f.store.query = async (statement, params, connection) => {
        if (/^INSERT INTO \S+\._events /.test(statement)) await sql.unsafe(marker);
        return query(statement, params, connection);
      };
      const meter = await meterSql();
      try {
        const statements = await meter.during(async () => {
          assertWrite(await f.write({ events: [{ kind: "visit" }] }, "metered"));
        });
        const steps = statements.flatMap((statement) =>
          statement === marker
            ? ["store insert"]
            : /FROM pulse\.sources .*FOR NO KEY U/.test(statement)
              ? ["exclusive source lock"]
              : /FROM pulse\.sources .*FOR KEY SHAR/.test(statement)
                ? ["shared source lock"]
                : [],
        );
        // T1 orders acceptance; T2 inserts under the shared lock and serializes only its bookkeeping afterwards.
        expect(steps).toEqual(["exclusive source lock", "shared source lock", "store insert", "exclusive source lock"]);
        // Pre-check 4, T1 21 and T2 14 statements.
        expect(statements.filter((statement) => statement !== marker)).toHaveLength(39);
      } finally {
        await meter.close();
      }
    } finally {
      await f.cleanup();
    }
  }, 60000);
});
