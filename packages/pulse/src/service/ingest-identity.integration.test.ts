import { beforeAll, expect, spyOn, test } from "bun:test";
import { SQL, sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { installFixtureStore } from "../store/base-store.test-fixture";
import { adminBaseAction } from "./base-admin";
import * as lifecycle from "./base-lifecycle";
import { clearBaseData } from "./base-management";
import { deterministicRowId, type PlannedStates, valueHash } from "./ingest-bulk";
import { createIngestWriter } from "./ingest-writer";
import { assertWrite, writeFixture } from "./write.test-fixture";

suiteFor(
  "database",
  "valkey",
  "clickhouse",
)("Pulse ClickHouse write identity", () => {
  beforeAll(installFixtureStore, 30000);
  test("a pending state plan replays its history after a newer batch advances the variant", async () => {
    const f = await writeFixture("state-plan-retry");
    try {
      await f.stopMerges();
      const batchA = { states: [{ key: "door", value: "A", ts: "2026-10-17T10:00:00Z" }] };
      f.failInsert(2); // _states_current succeeds; _state_changes fails.
      expect(await f.write(batchA, "A")).toMatchObject({ ok: false, error: { status: 503 } });
      expect(await f.read("states", "value")).toEqual([{ value: '"A"' }]);
      expect(await f.read("_state_changes", "count() AS n")).toEqual([{ n: 0 }]);
      const [pending] = await sql<{ state: string; planned_states: PlannedStates }[]>`
        SELECT state,planned_states FROM pulse.ingest_idempotency WHERE source_id=${f.sourceId}::uuid AND idempotency_key='A'`;
      if (!pending) throw new Error("Missing pending state plan");
      expect(pending.state).toBe("pending");
      expect(pending.planned_states).toHaveLength(batchA.states.length);
      f.recover();
      f.setTime("2026-10-17T12:01:00Z");
      assertWrite(await f.writeB({ states: [{ key: "door", value: "B", ts: "2026-10-17T10:01:00Z" }] }, "B"));
      assertWrite(await f.write(batchA, "A"));
      assertWrite(await f.write(batchA, "A")); // A is done; no further effects.
      expect(await f.read("_state_changes", "value", "FINAL ORDER BY changed_at")).toEqual([{ value: '"A"' }, { value: '"B"' }]);
      expect(await f.read("states", "value")).toEqual([{ value: '"B"' }]);
      const [done] =
        await sql`SELECT state,planned_states FROM pulse.ingest_idempotency WHERE source_id=${f.sourceId}::uuid AND idempotency_key='A'`;
      expect(done?.state).toBe("done");
      expect(done?.planned_states).toEqual(pending.planned_states);
      expect(await f.read("_state_changes", "id,toString(version) AS version", "FINAL WHERE value='\"A\"'")).toEqual(
        pending.planned_states.map((s) => ({ id: s.change_id, version: s.version })),
      );
      expect((await sql`SELECT value_hash FROM pulse.state_variants WHERE base_id=${f.base.id}::uuid`)[0]?.value_hash).toBe(valueHash("B"));
    } finally {
      await f.cleanup();
    }
  }, 60000);
  for (const keyed of [true, false])
    test(`state registry commits before the first ${keyed ? "keyed" : "unkeyed"} insert`, async () => {
      const f = await writeFixture(`state-plan-before-insert-${keyed}`);
      const query = f.store.query;
      let observed = false;
      try {
        f.store.query = async (statement, params) => {
          if (statement.startsWith("INSERT INTO") && statement.includes("._states_current")) {
            const [variant] = await sql`SELECT value_hash FROM pulse.state_variants WHERE base_id=${f.base.id}::uuid`;
            expect(variant?.value_hash).toBe(valueHash("planned"));
            if (keyed) {
              const [reservation] = await sql`SELECT state,jsonb_array_length(planned_states) AS n
                FROM pulse.ingest_idempotency WHERE source_id=${f.sourceId}::uuid AND idempotency_key='planned'`;
              expect(reservation).toEqual({ state: "pending", n: 1 });
            }
            observed = true;
          }
          return query(statement, params);
        };
        f.failInsert(2); // Leave the current snapshot stored but fail its history.
        expect(await f.write({ states: [{ key: "door", value: "planned" }] }, keyed ? "planned" : undefined)).toMatchObject({
          ok: false,
          error: { status: 503 },
        });
        expect(observed).toBe(true);
        expect((await sql`SELECT value_hash FROM pulse.state_variants WHERE base_id=${f.base.id}::uuid`)[0]?.value_hash).toBe(
          valueHash("planned"),
        );
      } finally {
        await f.cleanup();
      }
    }, 60000);
  test("an expired key reused for another batch preserves both same-kind, same-timestamp events", async () => {
    const f = await writeFixture("expired-key-identity");
    try {
      await f.stopMerges();
      const event = { kind: "opened", ts: "2026-10-17T10:00:00Z" };
      assertWrite(await f.write({ events: [{ ...event, value: 1 }] }, "reused"));
      const [first] = await sql`SELECT accepted_at FROM pulse.ingest_idempotency WHERE source_id=${f.sourceId}::uuid`;
      f.setTime("2026-10-18T12:00:00Z"); // Exactly the first reservation's expiry.
      const batch = { events: [{ ...event, value: 2 }] };
      assertWrite(await f.writeB(batch, "reused"));
      const [second] = await sql`SELECT accepted_at FROM pulse.ingest_idempotency WHERE source_id=${f.sourceId}::uuid`;
      expect(second?.accepted_at.getTime()).toBeGreaterThan(first?.accepted_at.getTime());
      assertWrite(await f.write(batch, "reused"));
      expect(await f.read("events", "value", "ORDER BY value")).toEqual([{ value: 1 }, { value: 2 }]);
      expect(await f.read("events", "uniqExact(id) AS n")).toEqual([{ n: 2 }]);
    } finally {
      await f.cleanup();
    }
  }, 60000);
  test("#1 abort between inserts leaves pending; retry is one clean run, conflicting body is 409", async () => {
    const f = await writeFixture("retry"),
      clean = await writeFixture("retry-clean");
    try {
      await f.stopMerges();
      const batch = {
        metrics: [{ name: "load", value: 2 }],
        events: [
          {
            kind: "opened",
            dimensions: { zone: "eu" },
            attributes: { detail: "ok" },
            sensitive: { secret: "hidden" },
            payload: { raw: 1 },
          },
        ],
        states: [{ key: "door", value: true }],
      };
      assertWrite(await clean.write(batch, "clean"));
      f.failInsert(3); // _series and _samples succeeded; _events fails.
      expect(await f.write(batch, "fixed")).toMatchObject({ ok: false, error: { status: 503, retryAfter: 30 } });
      const [key] =
        await sql`SELECT state,accepted_at FROM pulse.ingest_idempotency WHERE source_id=${f.sourceId}::uuid AND idempotency_key='fixed'`;
      expect(key?.state).toBe("pending");
      expect(key?.accepted_at.toISOString()).toBe(f.clock().toISOString());
      f.recover();
      f.setTime("2026-10-17T12:01:00Z");
      assertWrite(await f.write(batch, "fixed"));
      expect(
        await f
          .read("samples", "value,toUnixTimestamp64Milli(ts) AS ts")
          .then((rows) => rows.map((r) => ({ value: r.value, ts: Number(r.ts) }))),
      ).toEqual([{ value: 2, ts: Date.parse("2026-10-17T12:00:00Z") }]);
      expect(await f.read("events", "kind,dimensions,attributes")).toEqual([
        { kind: "opened", dimensions: '{"zone":"eu"}', attributes: '{"detail":"ok"}' },
      ]);
      expect(await f.read("states", "value")).toEqual([{ value: "true" }]);
      for (const [view, columns] of [
        ["samples", "ts,value"],
        ["events", "ts,kind,dimensions,attributes"],
        ["states", "state_key,value,dimensions,updated_at"],
        ["_state_changes", "state_key,value,dimensions,changed_at"],
      ] as const)
        expect(await f.read(view, columns)).toEqual(await clean.read(view, columns));
      const [hidden] = await f.read("_events", "sensitive,payload");
      expect(hidden).toEqual({ sensitive: '{"secret":"hidden"}', payload: '{"raw":1}' });
      f.failInsert(1); // done response cannot attempt another insert.
      expect(await f.write(batch, "fixed")).toEqual({ ok: true, data: { metrics: 1, events: 1, states: 1 } });
      expect(await f.write({ ...batch, events: [{ kind: "other" }] }, "fixed")).toMatchObject({ ok: false, error: { status: 409 } });
      f.failInsert(2);
      expect(await f.write({ metrics: [{ name: "new", value: 3 }], events: [{ kind: "new" }] })).toMatchObject({
        ok: false,
        error: {
          status: 503,
          message:
            "Pulse data store is unavailable. The batch may be partly stored, and sending it again can store those parts twice. Send every batch with an Idempotency-Key from the first attempt to retry safely.",
        },
      });
    } finally {
      await f.cleanup();
      await clean.cleanup();
    }
  }, 60000);
  test("#2 another instance's correction is immediately visible with merges stopped", async () => {
    const f = await writeFixture("correction");
    try {
      await f.stopMerges();
      const ts = "2026-10-17T10:05:00Z";
      assertWrite(await f.write({ metrics: [{ name: "load", value: 1, ts }] }, "first"));
      f.setTime("2026-10-17T12:00:00.001Z");
      assertWrite(await f.writeB({ metrics: [{ name: "load", value: 9, ts }] }, "corrected"));
      expect(await f.read("samples", "value")).toEqual([{ value: 9 }]);
      expect(Number((await f.read("_samples", "count() AS n"))[0]?.n)).toBe(2);
    } finally {
      await f.cleanup();
    }
  }, 60000);
  test("another source can finish writing while a ClickHouse insert is in flight", async () => {
    const f = await writeFixture("parallel-sources");
    const sourceB = deterministicRowId(f.sourceId, "parallel", "source", 1);
    let resume: (() => void) | undefined, entered: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const query = f.store.query;
    let write: ReturnType<typeof f.write> | undefined;
    let other: ReturnType<typeof f.write> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name)
        VALUES(${sourceB}::uuid,${sourceB.replaceAll("-", "").slice(0, 6)},${f.base.id}::uuid,'http_ingest','Parallel source')`;
      f.store.query = async (statement, params) => {
        if (statement.startsWith("INSERT INTO") && statement.includes("._samples")) {
          entered?.();
          await released;
        }
        return query(statement, params);
      };
      write = f.write({ metrics: [{ name: "load", value: 1 }] });
      await Promise.race([
        paused,
        write.then(() => {
          throw new Error("Write finished before sample insert");
        }),
      ]);
      other = createIngestWriter({ store: f.other, clock: f.clock })({
        baseId: f.base.id,
        sourceId: sourceB,
        batch: { metrics: [{ name: "load", value: 2 }] },
      });
      assertWrite(
        await Promise.race([
          other,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Independent source was blocked")), 5000);
          }),
        ]),
      );
      resume?.();
      assertWrite(await write);
      expect(await f.read("samples", "value", "ORDER BY value")).toEqual([{ value: 1 }, { value: 2 }]);
    } finally {
      clearTimeout(timeout);
      resume?.();
      await Promise.allSettled([write, other]);
      await f.cleanup();
    }
  }, 60000);
  for (const { reset, keyed } of [
    { reset: "clear", keyed: false },
    { reset: "recreate", keyed: false },
    { reset: "clear", keyed: true },
    { reset: "recreate", keyed: true },
  ] as const)
    test(`${reset} between T1 and T2 refuses a ${keyed ? "keyed mixed" : "unkeyed event"} batch and stores nothing`, async () => {
      const f = await writeFixture(`reset-between-transactions-${reset}-${keyed}`);
      const database = new SQL({ max: 2 });
      const begin = database.begin.bind(database);
      const submit = spyOn(lifecycle, "submitBaseLifecycleJob").mockResolvedValue(undefined);
      const userId = "33333333-3333-4333-8333-333333333333";
      let transactions = 0;
      // The injectable SQL client supplies the fault boundary, after T1 commits
      // and before T2 takes its lifecycle locks. The reset uses the real actions.
      const boundary = spyOn(database, "begin").mockImplementation(async (run) => {
        if (++transactions === 2) {
          expect(await sql`SELECT kind FROM pulse.event_kinds WHERE base_id=${f.base.id}::uuid`).toHaveLength(1);
          if (reset === "clear") {
            const result = await clearBaseData({ baseId: f.base.id, user: { id: userId } });
            if (!result.ok) throw new Error(result.error.message);
          } else {
            await adminBaseAction(adminFixtureIdentity(userId), f.base.shortId, "recreate");
          }
          const clear = lifecycle.createBaseLifecycle(f.store);
          for (let i = 0; i < 20; i++) if ((await clear(f.base.id)).done) break;
          expect((await sql`SELECT state FROM pulse.base_stores WHERE base_id=${f.base.id}::uuid`)[0]?.state).toBe("active");
        }
        if (typeof run === "string") throw new Error("Unexpected transaction options in ingest fixture");
        return begin(run);
      });
      try {
        await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${userId}::uuid,${userId},'local','user')`;
        const [grant] = await sql`INSERT INTO auth.access(user_id,permission) VALUES(${userId}::uuid,'admin') RETURNING id`;
        await sql`INSERT INTO pulse.base_access VALUES(${f.base.id}::uuid,${grant!.id}::uuid)`;
        expect(
          await createIngestWriter({ store: f.store, clock: f.clock, database })({
            baseId: f.base.id,
            sourceId: f.sourceId,
            batch: {
              events: [{ kind: "must-not-reappear" }],
              ...(keyed ? { metrics: [{ name: "old-reservation", value: 1 }], states: [{ key: "old-state", value: true }] } : {}),
            },
            idempotencyKey: keyed ? "before-reset" : undefined,
          }),
        ).toMatchObject({ ok: false, error: { status: 409, message: "Base data was reset during ingest" } });
        expect(transactions).toBe(2);
        expect(await f.read("samples", "count() AS n")).toEqual([{ n: 0 }]);
        expect(await f.read("events", "count() AS n")).toEqual([{ n: 0 }]);
        expect(await f.read("states", "count() AS n")).toEqual([{ n: 0 }]);
        expect(await sql`SELECT id FROM pulse.metric_series WHERE base_id=${f.base.id}::uuid`).toHaveLength(0);
        expect(await sql`SELECT kind FROM pulse.event_kinds WHERE base_id=${f.base.id}::uuid`).toHaveLength(0);
        expect(await sql`SELECT hour FROM pulse.metric_hours WHERE base_id=${f.base.id}::uuid`).toHaveLength(0);
        expect(await sql`SELECT state_key FROM pulse.state_keys WHERE base_id=${f.base.id}::uuid`).toHaveLength(0);
        expect(await sql`SELECT idempotency_key FROM pulse.ingest_idempotency WHERE source_id=${f.sourceId}::uuid`).toHaveLength(0);
        expect(
          Number((await sql`SELECT reset_generation FROM pulse.base_stores WHERE base_id=${f.base.id}::uuid`)[0]?.reset_generation),
        ).toBe(1);
        assertWrite(await f.write({ events: [{ kind: "after-reset" }] }));
        expect(await f.read("events", "kind")).toEqual([{ kind: "after-reset" }]);
      } finally {
        boundary.mockRestore();
        submit.mockRestore();
        await database.close();
        await f.cleanup();
        await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
      }
    }, 60000);
  test("T2 holds lifecycle locks across inserts; later writes see clear/delete state", async () => {
    const f = await writeFixture("write-lifecycle");
    let resume: (() => void) | undefined, entered: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const query = f.store.query;
    let write: ReturnType<typeof f.write> | undefined;
    try {
      f.store.query = async (statement, params) => {
        if (statement.startsWith("INSERT INTO") && statement.includes("._samples")) {
          entered?.();
          await released;
        }
        return query(statement, params);
      };
      write = f.write({ metrics: [{ name: "load", value: 1 }] }, "in-flight");
      // A failed write must also unblock this rendezvous so the test fails visibly.
      await Promise.race([
        paused,
        write.then(() => {
          throw new Error("Write finished before sample insert");
        }),
      ]);
      for (const table of ["bases", "base_stores"] as const) {
        await expect(
          sql.begin(async (tx) => {
            if (table === "bases") await tx`SELECT id FROM pulse.bases WHERE id=${f.base.id}::uuid FOR UPDATE NOWAIT`;
            else await tx`SELECT base_id FROM pulse.base_stores WHERE base_id=${f.base.id}::uuid FOR UPDATE NOWAIT`;
          }),
        ).rejects.toThrow("could not obtain lock");
      }
      resume?.();
      assertWrite(await write);
      for (const state of ["clearing", "deleting"] as const) {
        await sql.begin(async (tx) => {
          await tx`SELECT id FROM pulse.bases WHERE id=${f.base.id}::uuid FOR UPDATE`;
          await tx`UPDATE pulse.base_stores SET state=${state},operation=${state === "clearing" ? "clear" : "delete"} WHERE base_id=${f.base.id}::uuid`;
        });
        expect(await f.write({ events: [{ kind: "refused" }] })).toMatchObject({ ok: false, error: { status: 409 } });
      }
    } finally {
      resume?.();
      await write;
      await f.cleanup();
    }
  }, 60000);
});
