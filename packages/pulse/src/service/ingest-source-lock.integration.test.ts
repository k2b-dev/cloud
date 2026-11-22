import { beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { err, fail } from "@k2b/cloud/server";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { clickhouseTestPrefix } from "../../../../scripts/fixtures/test-clickhouse";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { baseStore } from "../store/base-store";
import { installFixtureStore } from "../store/base-store.test-fixture";
import { deterministicRowId } from "./ingest-bulk";
import { removeSource, updateSource } from "./source-management";
import { mirrorPendingSources } from "./source-mirror";
import { assertWrite, writeFixture } from "./write.test-fixture";

type FixtureStore = Awaited<ReturnType<typeof writeFixture>>["store"];
const isEventInsert = (statement: string) => /^INSERT INTO \S+\._events /.test(statement);

/** Holds every event insert until `writers` inserts run at the same time, or until `limitMs` passes. */
const gateEventInserts = (store: FixtureStore, writers: number, limitMs: number) => {
  const query = store.query;
  let inFlight = 0;
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const seen = { peak: 0 };
  store.query = async (statement, params, connection) => {
    if (!isEventInsert(statement)) return query(statement, params, connection);
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

/** Holds the next event insert, so its ingest stays inside T2 with the shared source lock, until `release()`. */
const holdEventInsert = (store: FixtureStore) => {
  const query = store.query;
  let entered = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  store.query = async (statement, params, connection) => {
    if (isEventInsert(statement)) {
      entered();
      await released;
    }
    return query(statement, params, connection);
  };
  return { entered: reached, release };
};

/** Fails instead of waiting when `run` does not finish within `ms`. */
const within = async <T>(ms: number, run: Promise<T>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Still waiting after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
      const seen = gateEventInserts(f.store, 2, 8_000);
      const batch = { events: [{ kind: "checkout", value: 7 }] };
      const [first, retry] = await Promise.all([f.write(batch, "same-key"), f.write(batch, "same-key")]);
      expect(assertWrite(first)).toEqual({ metrics: 0, events: 1, states: 0 });
      expect(assertWrite(retry)).toEqual({ metrics: 0, events: 1, states: 0 });
      // Both attempts wrote at the same time: the retry did not wait for the first attempt's insert.
      expect(seen.peak).toBe(2);
      expect(await f.read("events", "id,toInt64(value) AS value")).toHaveLength(1);
      expect(await sql<{ state: string }[]>`SELECT state FROM pulse.ingest_idempotency WHERE source_id=${f.sourceId}::uuid`).toEqual([
        { state: "done" },
      ]);
    } finally {
      await f.cleanup();
    }
  }, 60000);

  test("a source change waits for a running ingest write only within the ingest lock budget, then asks for a retry", async () => {
    const f = await writeFixture("source-lock-change");
    // Source changes mirror afterwards; this test checks their locks, not the mirror's store I/O.
    const offline = spyOn(baseStore, "prepare").mockRejectedValue(new Error("Fixture store offline"));
    const [writer] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
      VALUES(${`pulse_lock_${testShortId(8)}`},'local','user','Source writer') RETURNING id`;
    const [grant] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(user_id,permission) VALUES(${writer!.id}::uuid,'write') RETURNING id`;
    await sql`INSERT INTO pulse.base_access VALUES(${f.base.id}::uuid,${grant!.id}::uuid)`;
    const held = holdEventInsert(f.store);
    try {
      const scope = { baseId: f.base.id, sourceId: f.sourceId, user: { id: writer!.id } };
      const write = f.write({ events: [{ kind: "accepted-before-disable" }] }, "held");
      await held.entered;
      const started = performance.now();
      // Removal shares this lock path (changeSource); one waiter keeps the test at one lock budget.
      expect(await updateSource({ ...scope, enabled: false })).toEqual(
        fail(err.unavailable("The Pulse source is busy receiving data. Retry the change in a moment.")),
      );
      // The 30-second ingest lock budget, not an open-ended wait.
      expect(performance.now() - started).toBeLessThan(45_000);
      held.release();
      expect(assertWrite(await write)).toEqual({ metrics: 0, events: 1, states: 0 });
      // Once the write finished, the change goes through and the source refuses new data.
      expect(await updateSource({ ...scope, enabled: false })).toMatchObject({ ok: true, data: { enabled: false } });
      expect(await f.write({ events: [{ kind: "after-disable" }] })).toMatchObject({
        ok: false,
        error: { code: "PULSE_SOURCE_DISABLED" },
      });
      expect(await removeSource(scope)).toMatchObject({ ok: true });
    } finally {
      held.release();
      offline.mockRestore();
      await f.cleanup();
      await sql`DELETE FROM auth.access WHERE id=${grant!.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${writer!.id}::uuid`;
    }
  }, 90000);

  test("the source mirror neither waits for running ingest writes nor for a locked source", async () => {
    const f = await writeFixture("source-lock-mirror");
    const otherId = deterministicRowId(clickhouseTestPrefix, "source-lock-mirror", "source", 1);
    await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name,created_at,updated_at)
      VALUES(${otherId}::uuid,${otherId.replaceAll("-", "").slice(0, 6)},${f.base.id}::uuid,'http_ingest','Other source',${f.clock()},${f.clock()})`;
    const held = holdEventInsert(f.store);
    let unlock = () => {};
    try {
      // A running ingest write holds KEY SHARE; the mirror locks NO KEY UPDATE and passes it.
      const write = f.write({ events: [{ kind: "held" }] }, "held");
      await held.entered;
      await within(5_000, mirrorPendingSources(f.base.id, f.store));
      expect(await f.read("sources", "name", "ORDER BY name")).toEqual([{ name: "Other source" }, { name: "Write fixture" }]);
      held.release();
      assertWrite(await write);

      // A source change holds its row: the mirror skips it, keeps it pending, and still mirrors the other source.
      await sql`UPDATE pulse.sources SET name=name||' renamed',mirror_pending=true,updated_at=updated_at+interval '1 second'
        WHERE base_id=${f.base.id}::uuid`;
      let locked = () => {};
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const released = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const change = sql.begin(async (tx) => {
        await tx`SELECT 1 FROM pulse.sources WHERE id=${f.sourceId}::uuid FOR UPDATE`;
        locked();
        await released;
      });
      await lockTaken;
      await within(5_000, mirrorPendingSources(f.base.id, f.store));
      expect(
        await sql<{ id: string; mirror_pending: boolean }[]>`SELECT id::text AS id,mirror_pending FROM pulse.sources
          WHERE base_id=${f.base.id}::uuid ORDER BY name`,
      ).toEqual([
        { id: otherId, mirror_pending: false },
        { id: f.sourceId, mirror_pending: true },
      ]);
      unlock();
      await change;
      // The next pass mirrors the skipped source.
      await mirrorPendingSources(f.base.id, f.store);
      expect(await f.read("sources", "name", "ORDER BY name")).toEqual([
        { name: "Other source renamed" },
        { name: "Write fixture renamed" },
      ]);
    } finally {
      held.release();
      unlock();
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
        if (isEventInsert(statement)) await sql.unsafe(marker);
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
