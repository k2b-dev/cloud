import { beforeAll, expect, spyOn, test } from "bun:test";
import { SQL, sql } from "bun";
import { clickhouseAdminQuery as admin, clickhouseTestAdmin } from "../../../../scripts/fixtures/test-clickhouse";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { BaseOperationSuperseded, loadStoreRow } from "../store/base-store";
import { installFixtureStore } from "../store/base-store.test-fixture";
import { clickhouseQuery, StoreQueryError } from "../store/client";
import { acceptCheckpoint, insertCheckpoint, prepareCheckpoint, verifyBaseCheckpoint, writeBaseCheckpoint } from "../store/maintenance";
import { quoteIdentifier as q } from "../store/validation";
import * as lifecycle from "./base-lifecycle";
import { clearBaseData } from "./base-management";
import { createIngestWriter } from "./ingest-writer";
import { createHourlyRollup } from "./metric-rollups";
import { runMetricsSourceScrape } from "./metrics-scraper";
import { createRetention } from "./retention";
import { mirrorPendingSources } from "./source-mirror";
import { assertWrite, writeFixture } from "./write.test-fixture";

const nextCheckpoint = "11111111-2222-4333-8444-555555555555";
const pendingCheckpoint = "22222222-2222-4333-8444-555555555555";

suiteFor(
  "database",
  "valkey",
  "clickhouse",
)("Pulse runtime recovery", () => {
  beforeAll(installFixtureStore, 30_000);

  test("a surviving receipt replays a restored checkpoint without changing event/state identities", async () => {
    const f = await writeFixture("recovery-receipt");
    const session = "recovery_receipt_session";
    const backup = `recovery_${f.base.id.replaceAll("-", "")}`;
    const command = (query: string) =>
      clickhouseQuery({ ...clickhouseTestAdmin(), query, timeoutMs: 5_000, settings: { session_id: session } });
    try {
      await f.stopMerges();
      await command(`BACKUP DATABASE ${q(f.base.database)} TO Memory('${backup}')`);
      const batch = { metrics: [{ name: "load", value: 3 }], events: [{ kind: "opened" }], states: [{ key: "door", value: "open" }] };
      assertWrite(await f.write(batch, "delivery"));
      const events = await f.read("_events", "id,ts,version", "FINAL");
      const series = await f.read("series", "series_id,metric");
      const samples = await f.read("samples", "series_id,ts,value");
      const history = await f.read("_state_changes", "id,changed_at,version");
      const [receipt] = await sql`SELECT accepted_at,planned_states FROM pulse.ingest_idempotency WHERE source_id=${f.sourceId}::uuid`;
      await command(`DROP DATABASE ${q(f.base.database)} SYNC`);
      await command(`RESTORE DATABASE ${q(f.base.database)} FROM Memory('${backup}')`);
      await f.stopMerges();
      expect(await f.read("events", "count() AS n")).toEqual([{ n: 0 }]);
      // The approved hourly boundary cannot detect per-batch loss within the same identity.
      assertWrite(await f.writeB(batch, "delivery"));
      expect(await f.read("events", "count() AS n")).toEqual([{ n: 0 }]);
      // A checkpoint transition invalidates completion and requires the original rows to replay.
      await writeBaseCheckpoint(f.base.id, nextCheckpoint, f.store);
      f.setTime("2026-10-17T12:05:00Z");
      assertWrite(await f.write(batch, "delivery"));
      assertWrite(await f.writeB(batch, "delivery"));
      expect(await f.read("_events", "id,ts,version", "FINAL")).toEqual(events);
      expect(await f.read("series", "series_id,metric")).toEqual(series);
      expect(await f.read("samples", "series_id,ts,value")).toEqual(samples);
      expect(await f.read("_state_changes", "id,changed_at,version", "FINAL")).toEqual(history);
      expect((await sql`SELECT accepted_at,planned_states FROM pulse.ingest_idempotency WHERE source_id=${f.sourceId}::uuid`)[0]).toEqual(
        receipt,
      );
      expect(await f.write({ events: [{ kind: "different" }] }, "delivery")).toMatchObject({ ok: false, error: { status: 409 } });
      f.failInsert(1);
      expect(await f.write(batch, "delivery")).toEqual({ ok: true, data: { metrics: 1, events: 1, states: 1 } });
      f.recover();
      expect(await f.write(batch, "delivery")).toEqual({ ok: true, data: { metrics: 1, events: 1, states: 1 } });
    } finally {
      await f.cleanup();
    }
  }, 60_000);

  test("valid completed retries have no quota, registry, hour or physical insert effects", async () => {
    const f = await writeFixture("recovery-completed");
    let charges = 0;
    const writer = createIngestWriter({
      store: f.store,
      clock: f.clock,
      quota: {
        consume: async () => {
          charges++;
          return charges === 1 ? null : { code: "PULSE_BASE_THROTTLED", status: 429, message: "Fixture throttle", retryAfter: 1 };
        },
        close: () => {},
      },
    });
    const batch = { metrics: [{ name: "load", value: 1 }], events: [{ kind: "healthy" }] };
    const write = () => writer({ baseId: f.base.id, sourceId: f.sourceId, batch, idempotencyKey: "healthy" });
    try {
      await f.stopMerges();
      assertWrite(await write());
      await sql`UPDATE pulse.metric_hours SET state='clean',lease_until=NULL WHERE base_id=${f.base.id}::uuid`;
      const before = await sql`SELECT * FROM pulse.sources WHERE id=${f.sourceId}::uuid`;
      const hours = await sql`SELECT * FROM pulse.metric_hours WHERE base_id=${f.base.id}::uuid`;
      const series = await sql`SELECT * FROM pulse.metric_series WHERE base_id=${f.base.id}::uuid`;
      const physical = await f.read("_events", "count() AS n");
      await sql`UPDATE pulse.base_stores SET usage_bytes=storage_bytes WHERE base_id=${f.base.id}::uuid`;
      f.setTime("2026-10-17T12:01:00Z");
      f.failInsert(1);
      expect(await write()).toEqual({ ok: true, data: { metrics: 1, events: 1, states: 0 } });
      expect(charges).toBe(1);
      expect(await sql`SELECT * FROM pulse.sources WHERE id=${f.sourceId}::uuid`).toEqual(before);
      expect(await sql`SELECT * FROM pulse.metric_hours WHERE base_id=${f.base.id}::uuid`).toEqual(hours);
      expect(await sql`SELECT * FROM pulse.metric_series WHERE base_id=${f.base.id}::uuid`).toEqual(series);
      expect(await f.read("_events", "count() AS n")).toEqual(physical);
    } finally {
      await f.cleanup();
    }
  }, 60_000);

  test("checkpoint invalidation charges quota and renews validity only after successful replay", async () => {
    const f = await writeFixture("recovery-invalidated");
    let throttled = false,
      charges = 0;
    const writer = createIngestWriter({
      store: f.store,
      clock: f.clock,
      quota: {
        consume: async () => {
          charges++;
          return throttled ? { code: "PULSE_BASE_THROTTLED", status: 429, message: "Fixture throttle", retryAfter: 1 } : null;
        },
        close: () => {},
      },
    });
    const batch = { states: [{ key: "door", value: "A" }], events: [{ kind: "first" }] };
    const write = () => writer({ baseId: f.base.id, sourceId: f.sourceId, batch, idempotencyKey: "A" });
    const receipt = async () =>
      (await sql`SELECT * FROM pulse.ingest_idempotency WHERE source_id=${f.sourceId}::uuid AND idempotency_key='A'`)[0];
    try {
      await f.stopMerges();
      assertWrite(await write());
      const original = await receipt();
      f.setTime("2026-10-17T12:01:00Z");
      assertWrite(await f.write({ states: [{ key: "door", value: "B" }] }, "B"));
      await writeBaseCheckpoint(f.base.id, nextCheckpoint, f.store);
      throttled = true;
      expect(await write()).toMatchObject({ ok: false, error: { status: 429 } });
      expect(await receipt()).toEqual(original);
      throttled = false;
      f.failInsert(1);
      expect(await write()).toMatchObject({ ok: false, error: { status: 503 } });
      expect(await receipt()).toEqual(original);
      f.recover();
      assertWrite(await write());
      const renewed = await receipt();
      expect(renewed).toMatchObject({
        accepted_at: original.accepted_at,
        planned_states: original.planned_states,
        checkpoint_id: nextCheckpoint,
      });
      expect(await f.read("states", "value")).toEqual([{ value: '\"B\"' }]);
      expect(await f.read("_state_changes", "value", "FINAL ORDER BY changed_at")).toEqual([{ value: '\"A\"' }, { value: '\"B\"' }]);
      const charged = charges;
      assertWrite(await write());
      expect(charges).toBe(charged);
    } finally {
      await f.cleanup();
    }
  }, 60_000);

  test("checkpoint acceptance cannot accept another execution's uninserted pending ID", async () => {
    const f = await writeFixture("recovery-checkpoint-accept");
    const step = f.store.step.bind(f.store);
    let interleaved = false;
    const boundary = spyOn(f.store, "step").mockImplementation(async (...args) => {
      if (args[2] === "checkpoint_accept" && !interleaved) {
        interleaved = true;
        await writeBaseCheckpoint(f.base.id, nextCheckpoint, f.other);
        await f.other.step(f.base.id, "reconcile", "checkpoint_pending", async (row, db) => prepareCheckpoint(row, db, pendingCheckpoint));
      }
      return step(...args);
    });
    try {
      await expect(writeBaseCheckpoint(f.base.id, nextCheckpoint, f.store)).rejects.toBeInstanceOf(BaseOperationSuperseded);
      expect(interleaved).toBe(true);
      expect(await loadStoreRow(f.base.id)).toMatchObject({ checkpoint_id: nextCheckpoint, pending_checkpoint_id: pendingCheckpoint });
      expect(await verifyBaseCheckpoint(f.base.id, f.other)).toBe(true);
      await writeBaseCheckpoint(f.base.id, nextCheckpoint, f.other);
      expect(await loadStoreRow(f.base.id)).toMatchObject({ checkpoint_id: pendingCheckpoint, pending_checkpoint_id: null });
      expect(await verifyBaseCheckpoint(f.base.id, f.other)).toBe(true);
    } finally {
      boundary.mockRestore();
      await f.cleanup();
    }
  }, 60_000);

  test("a checkpoint inserted before a reset cannot be accepted in the new generation", async () => {
    const f = await writeFixture("recovery-checkpoint-generation");
    try {
      const committed = (await loadStoreRow(f.base.id))!.checkpoint_id;
      await f.store.step(f.base.id, "reconcile", "checkpoint_pending", async (row, db) => prepareCheckpoint(row, db, nextCheckpoint));
      let inserted: Awaited<ReturnType<typeof insertCheckpoint>> | undefined;
      await f.store.step(f.base.id, "reconcile", "checkpoint_insert", async (row) => {
        inserted = await insertCheckpoint(row, f.store);
      });
      await sql`UPDATE pulse.base_stores SET reset_generation=reset_generation+1 WHERE base_id=${f.base.id}::uuid`;
      await expect(
        f.store.step(f.base.id, "reconcile", "checkpoint_accept", async (row, db) => acceptCheckpoint(row, db, inserted, f.clock)),
      ).rejects.toBeInstanceOf(BaseOperationSuperseded);
      expect(await loadStoreRow(f.base.id)).toMatchObject({
        checkpoint_id: committed,
        pending_checkpoint_id: nextCheckpoint,
        reset_generation: "1",
      });
    } finally {
      await f.cleanup();
    }
  }, 60_000);

  for (const transition of ["unchanged", "revision", "generation"] as const)
    test(`failed rollup backoff respects a concurrent ${transition}`, async () => {
      const f = await writeFixture(`recovery-rollup-failure-${transition}`);
      const database = new SQL({ max: 1 });
      const begin = database.begin.bind(database);
      const query = f.store.query;
      const hour = new Date("2026-10-17T10:00:00Z");
      let interleaved = false;
      const boundary = spyOn(database, "begin").mockImplementation(async (run) => {
        if (typeof run === "string") throw new Error("Unexpected transaction options");
        try {
          return await begin(run);
        } catch (error) {
          if (!interleaved) {
            interleaved = true;
            await sql.begin(async (tx) => {
              await tx`SELECT id FROM pulse.bases WHERE id=${f.base.id}::uuid FOR UPDATE`;
              await tx`SELECT base_id FROM pulse.base_stores WHERE base_id=${f.base.id}::uuid FOR UPDATE`;
              if (transition === "generation")
                await tx`UPDATE pulse.base_stores SET reset_generation=reset_generation+1 WHERE base_id=${f.base.id}::uuid`;
              if (transition === "revision")
                await tx`UPDATE pulse.metric_hours SET revision=revision+1 WHERE base_id=${f.base.id}::uuid AND hour=${hour}`;
            });
          }
          throw error;
        }
      });
      try {
        await sql`INSERT INTO pulse.metric_hours(base_id,hour,state) VALUES(${f.base.id}::uuid,${hour},'dirty')`;
        f.store.query = async (statement, params, connection) => {
          if (statement.startsWith("INSERT INTO") && statement.includes("._rollups")) throw new StoreQueryError("unreachable");
          return query(statement, params, connection);
        };
        await expect(createHourlyRollup({ store: f.store, database, clock: f.clock })(f.base.id)).rejects.toThrow();
        expect(interleaved).toBe(true);
        const [row] = await sql`SELECT lease_until FROM pulse.metric_hours WHERE base_id=${f.base.id}::uuid AND hour=${hour}`;
        expect(row?.lease_until).toEqual(transition === "unchanged" ? new Date("2026-10-17T13:00:00Z") : null);
      } finally {
        boundary.mockRestore();
        await database.close();
        f.store.query = query;
        await f.cleanup();
      }
    }, 60_000);

  test("a pending receipt restores its referenced series even when another batch acknowledged the mirror", async () => {
    const f = await writeFixture("recovery-pending-series");
    const backup = `pending_${f.base.id.replaceAll("-", "")}`;
    const command = (query: string) =>
      clickhouseQuery({ ...clickhouseTestAdmin(), query, timeoutMs: 5_000, settings: { session_id: "recovery_pending_series" } });
    try {
      await f.stopMerges();
      await command(`BACKUP DATABASE ${q(f.base.database)} TO Memory('${backup}')`);
      assertWrite(await f.write({ metrics: [{ name: "load", value: 1 }] }, "first"));
      const batch = { metrics: [{ name: "load", value: 2 }], events: [{ kind: "pending" }] };
      f.failInsert(2); // Existing series skips its mirror; the sample lands before the event fails.
      expect(await f.write(batch, "pending")).toMatchObject({ ok: false, error: { status: 503 } });
      expect((await sql`SELECT mirrored FROM pulse.metric_series WHERE base_id=${f.base.id}::uuid`)[0]?.mirrored).toBe(true);
      expect(
        (await sql`SELECT state FROM pulse.ingest_idempotency WHERE source_id=${f.sourceId}::uuid AND idempotency_key='pending'`)[0]?.state,
      ).toBe("pending");
      await command(`DROP DATABASE ${q(f.base.database)} SYNC`);
      await command(`RESTORE DATABASE ${q(f.base.database)} FROM Memory('${backup}')`);
      await f.stopMerges();
      f.recover();
      assertWrite(await f.write(batch, "pending"));
      expect(await f.read("series", "metric")).toEqual([{ metric: "load" }]);
      expect(await f.read("samples", "value")).toEqual([{ value: 2 }]);
    } finally {
      await f.cleanup();
    }
  }, 60_000);

  test("writes detect startup mismatch before any reservation, remain blocked, and recover after explicit recheck", async () => {
    const f = await writeFixture("recovery-startup");
    try {
      await f.stopMerges();
      const original = (await loadStoreRow(f.base.id))!.checkpoint_id;
      await admin(`TRUNCATE TABLE ${q(f.base.database)}._checkpoints`);
      await admin(
        `INSERT INTO ${q(f.base.database)}._checkpoints(id,at) VALUES('${nextCheckpoint}',fromUnixTimestamp64Milli(1792238400000))`,
      );
      // No startup job has run. A new writer instance must enforce admission itself.
      expect(await f.writeB({ events: [{ kind: "early" }] }, "early")).toMatchObject({
        ok: false,
        error: { code: "PULSE_BASE_WRITE_BLOCKED" },
      });
      expect(await sql`SELECT 1 FROM pulse.ingest_idempotency WHERE source_id=${f.sourceId}::uuid`).toHaveLength(0);
      expect(await f.read("events", "count() AS n")).toEqual([{ n: 0 }]);
      await admin(`TRUNCATE TABLE ${q(f.base.database)}._checkpoints`);
      await admin(`INSERT INTO ${q(f.base.database)}._checkpoints(id,at) VALUES('${original}',fromUnixTimestamp64Milli(1792238400000))`);
      expect(await f.write({ events: [{ kind: "early" }] }, "early")).toMatchObject({
        ok: false,
        error: { code: "PULSE_BASE_WRITE_BLOCKED" },
      });
      expect(await verifyBaseCheckpoint(f.base.id, f.store, true)).toBe(true);
      assertWrite(await f.write({ events: [{ kind: "early" }] }, "early"));
    } finally {
      await f.cleanup();
    }
  }, 60_000);

  test("background writes also enforce checkpoint admission before the startup scan", async () => {
    const f = await writeFixture("recovery-background");
    try {
      await sql`INSERT INTO pulse.metric_hours(base_id,hour,state) VALUES(${f.base.id}::uuid,'2026-10-17T10:00:00Z','dirty')`;
      await sql`UPDATE pulse.sources SET mirror_pending=true WHERE id=${f.sourceId}::uuid`;
      await admin(`TRUNCATE TABLE ${q(f.base.database)}._checkpoints`);
      for (const run of [
        () => createHourlyRollup({ store: f.store, clock: f.clock })(f.base.id),
        () => mirrorPendingSources(f.base.id, f.store),
        () => createRetention({ store: f.store, clock: f.clock })(f.base.id),
      ]) {
        await sql`UPDATE pulse.base_stores SET write_block_reason=NULL WHERE base_id=${f.base.id}::uuid`;
        await run();
        expect((await loadStoreRow(f.base.id))?.write_block_reason).toBe("checkpoint_mismatch");
      }
      expect(await f.read("rollups", "count() AS n")).toEqual([{ n: 0 }]);
      expect(await f.read("sources", "count() AS n")).toEqual([{ n: 0 }]);
      expect((await sql`SELECT state FROM pulse.metric_hours WHERE base_id=${f.base.id}::uuid`)[0]?.state).toBe("dirty");
    } finally {
      await f.cleanup();
    }
  }, 60_000);

  test("a completed receipt keeps its recovery horizon across later checkpoints until expiry", async () => {
    const f = await writeFixture("recovery-seal");
    try {
      const batch = { metrics: [{ name: "edge", value: 1, ts: "2026-09-17T13:00:00Z" }] };
      assertWrite(await f.write(batch, "edge"));
      await sql`UPDATE pulse.metric_hours SET state='clean',lease_until=NULL WHERE base_id=${f.base.id}::uuid`;
      f.setTime("2026-10-17T14:00:00Z");
      await createRetention({ store: f.store, clock: f.clock })(f.base.id);
      expect((await sql`SELECT state FROM pulse.metric_hours WHERE base_id=${f.base.id}::uuid`)[0]?.state).toBe("clean");
      assertWrite(await f.write(batch, "edge"));
      await writeBaseCheckpoint(f.base.id, nextCheckpoint, f.store);
      await sql`UPDATE pulse.metric_hours SET state='clean',lease_until=NULL WHERE base_id=${f.base.id}::uuid`;
      await createRetention({ store: f.store, clock: f.clock })(f.base.id);
      expect((await sql`SELECT state FROM pulse.metric_hours WHERE base_id=${f.base.id}::uuid`)[0]?.state).toBe("clean");
      assertWrite(await f.write(batch, "edge"));
      f.setTime("2026-10-18T12:00:00Z");
      await sql`UPDATE pulse.metric_hours SET state='clean',lease_until=NULL WHERE base_id=${f.base.id}::uuid`;
      await createRetention({ store: f.store, clock: f.clock })(f.base.id);
      expect((await sql`SELECT state FROM pulse.metric_hours WHERE base_id=${f.base.id}::uuid`)[0]?.state).toBe("sealed");
    } finally {
      await f.cleanup();
    }
  }, 60_000);

  for (const landed of [false, true])
    test(`a partially pending checkpoint (${landed ? "inserted" : "not inserted"}) allows replay of a completed receipt`, async () => {
      const f = await writeFixture(`recovery-pending-${landed}`);
      try {
        await f.stopMerges();
        await sql`UPDATE pulse.base_stores SET pending_checkpoint_id=${pendingCheckpoint}::uuid WHERE base_id=${f.base.id}::uuid`;
        if (landed)
          await f.store.query(
            `INSERT INTO ${q(f.base.database)}._checkpoints(id,at) VALUES('${pendingCheckpoint}',fromUnixTimestamp64Milli(1792238401000))`,
          );
        const batch = { events: [{ kind: "pending" }] };
        assertWrite(await f.write(batch, "pending"));
        const rows = await f.read("_events", "id,ts,version", "FINAL");
        // Finish the existing pending checkpoint, then simulate restoration to it.
        await writeBaseCheckpoint(f.base.id, nextCheckpoint, f.store);
        await admin(`TRUNCATE TABLE ${q(f.base.database)}._events`);
        assertWrite(await f.writeB(batch, "pending"));
        expect(await f.read("_events", "id,ts,version", "FINAL")).toEqual(rows);
        expect(await loadStoreRow(f.base.id)).toMatchObject({ checkpoint_id: pendingCheckpoint, pending_checkpoint_id: null });
      } finally {
        await f.cleanup();
      }
    }, 60_000);

  for (const field of ["generation", "checkpoint"] as const)
    test(`checkpoint admission releases Postgres before remote work and rejects a changed ${field}`, async () => {
      const f = await writeFixture(`recovery-admission-cas-${field}`);
      const query = f.store.query;
      let changed = false;
      try {
        f.store.query = async (statement, params, connection) => {
          if (!changed && statement.includes("._checkpoints ORDER BY")) {
            changed = true;
            await sql.begin(async (tx) => {
              await tx`SET LOCAL lock_timeout='1s'`.simple();
              if (field === "generation")
                await tx`UPDATE pulse.base_stores SET reset_generation=reset_generation+1 WHERE base_id=${f.base.id}::uuid`;
              else await tx`UPDATE pulse.base_stores SET checkpoint_id=${nextCheckpoint}::uuid WHERE base_id=${f.base.id}::uuid`;
            });
          }
          return query(statement, params, connection);
        };
        expect(await f.write({ events: [{ kind: "raced" }] }, "raced")).toMatchObject({ ok: false, error: { status: 503 } });
        expect(await f.read("events", "count() AS n")).toEqual([{ n: 0 }]);
        f.store.query = async () => {
          throw new StoreQueryError("unreachable");
        };
        expect(await f.write({ events: [{ kind: "offline" }] })).toMatchObject({ ok: false, error: { status: 503, retryAfter: 30 } });
        expect((await loadStoreRow(f.base.id))!.state).toBe("active");
      } finally {
        f.store.query = query;
        await f.cleanup();
      }
    }, 60_000);

  test("a throttled in-flight write cannot mark the source after clear", async () => {
    const f = await writeFixture("recovery-throttle");
    const database = new SQL({ max: 1 });
    const begin = database.begin.bind(database);
    const submit = spyOn(lifecycle, "submitBaseLifecycleJob").mockResolvedValue(undefined);
    const [user] = await sql`INSERT INTO auth.users(uid,provider,profile) VALUES(${`throttle-${f.base.id}`},'local','user') RETURNING id`;
    let cleared = false;
    const boundary = spyOn(database, "begin").mockImplementation(async (run) => {
      if (typeof run === "string") throw new Error("Unexpected transaction options");
      try {
        return await begin(run);
      } catch (error) {
        if (!cleared) {
          cleared = true;
          expect((await clearBaseData({ baseId: f.base.id, user: { id: user!.id } })).ok).toBe(true);
          for (let step = 0; step < 20; step++) if ((await lifecycle.createBaseLifecycle(f.store)(f.base.id)).done) break;
        }
        throw error;
      }
    });
    try {
      const [grant] = await sql`INSERT INTO auth.access(user_id,permission) VALUES(${user!.id}::uuid,'admin') RETURNING id`;
      await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${f.base.id}::uuid,${grant!.id}::uuid)`;
      const writer = createIngestWriter({
        database,
        store: f.store,
        clock: f.clock,
        quota: {
          consume: async () => ({ code: "PULSE_BASE_THROTTLED", status: 429, message: "Fixture throttle", retryAfter: 1 }),
          close: () => {},
        },
      });
      expect(
        await writer({ baseId: f.base.id, sourceId: f.sourceId, resetGeneration: "0", batch: { metrics: [{ name: "old", value: 1 }] } }),
      ).toMatchObject({ ok: false, error: { status: 429 } });
      expect(cleared).toBe(true);
      expect((await sql`SELECT throttled_at FROM pulse.sources WHERE id=${f.sourceId}::uuid`)[0]?.throttled_at).toBeNull();
    } finally {
      boundary.mockRestore();
      submit.mockRestore();
      await database.close();
      await f.cleanup();
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    }
  }, 60_000);

  for (const outcome of ["data", "error", "diagnostics", "after-ingest"] as const)
    test(`clear fences an in-flight scrape's ${outcome} and metadata`, async () => {
      const f = await writeFixture(`recovery-scrape-${outcome}`);
      let release!: () => void;
      let fetched!: () => void;
      const fetching = new Promise<void>((resolve) => {
        fetched = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const endpoint = Bun.serve({
        port: 0,
        fetch: async () => {
          if (outcome !== "after-ingest") {
            fetched();
            await resume;
          }
          return outcome === "error"
            ? new Response("offline", { status: 503 })
            : new Response(
                outcome === "data" || outcome === "after-ingest" ? "# TYPE up gauge\nup 1" : '# TYPE bad histogram\nbad_bucket{le="1"} 1',
              );
        },
      });
      const submit = spyOn(lifecycle, "submitBaseLifecycleJob").mockResolvedValue(undefined);
      let scrape: ReturnType<typeof runMetricsSourceScrape> | undefined;
      const [user] = await sql`INSERT INTO auth.users(uid,provider,profile) VALUES(${`recovery-${f.base.id}`},'local','user') RETURNING id`;
      try {
        const [grant] = await sql`INSERT INTO auth.access(user_id,permission) VALUES(${user!.id}::uuid,'admin') RETURNING id`;
        await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${f.base.id}::uuid,${grant!.id}::uuid)`;
        await sql`UPDATE pulse.sources SET kind='metrics',endpoint_url=${`http://127.0.0.1:${endpoint.port}/metrics`},config='{"metricFilters":["up","bad"]}'::jsonb WHERE id=${f.sourceId}::uuid`;
        await sql`INSERT INTO pulse.base_internal_targets(base_id,entry) VALUES(${f.base.id}::uuid,'127.0.0.1')`;
        scrape = runMetricsSourceScrape(
          { baseId: f.base.id, sourceId: f.sourceId },
          {
            clock: f.clock,
            ingestBatch: async (params) => {
              const result = await createIngestWriter({ store: f.store, clock: f.clock })(params);
              if (outcome === "after-ingest") {
                fetched();
                await resume;
              }
              return result;
            },
          },
        );
        await Promise.race([
          fetching,
          scrape.then((result) => {
            throw new Error(`Scrape ended before the interleaving boundary: ${result.ok ? "success" : result.error.code}`);
          }),
        ]);
        expect((await clearBaseData({ baseId: f.base.id, user: { id: user!.id } })).ok).toBe(true);
        for (let step = 0; step < 20; step++) if ((await lifecycle.createBaseLifecycle(f.store)(f.base.id)).done) break;
        expect((await loadStoreRow(f.base.id))?.state).toBe("active");
        expect((await sql`SELECT scrape_lease_until FROM pulse.sources WHERE id=${f.sourceId}::uuid`)[0]?.scrape_lease_until).toBeNull();
        const nextLease = new Date(f.clock().getTime() + 15_000 + 10 * 60_000);
        await sql`UPDATE pulse.sources SET scrape_lease_until=${nextLease} WHERE id=${f.sourceId}::uuid`;
        release();
        expect(await scrape).toMatchObject({ ok: false, error: { status: 409 } });
        expect(await f.read("samples", "count() AS n")).toEqual([{ n: 0 }]);
        expect(await sql`SELECT 1 FROM pulse.source_scrapes WHERE source_id=${f.sourceId}::uuid`).toHaveLength(0);
        expect(
          (
            await sql`SELECT last_seen_at,last_data_at,last_error,last_scrape_slot_at,refused_histograms,skipped_summaries,config,scrape_lease_until FROM pulse.sources WHERE id=${f.sourceId}::uuid`
          )[0],
        ).toEqual({
          last_seen_at: null,
          last_data_at: null,
          last_error: null,
          last_scrape_slot_at: null,
          refused_histograms: [],
          skipped_summaries: 0,
          config: { metricFilters: ["up", "bad"] },
          scrape_lease_until: nextLease,
        });
      } finally {
        release();
        await scrape?.catch(() => {});
        endpoint.stop(true);
        submit.mockRestore();
        await f.cleanup();
        await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
      }
    }, 60_000);
});
