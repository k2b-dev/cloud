import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { installFixtureStore } from "../store/base-store.test-fixture";
import { deterministicRowId } from "./ingest-bulk";
import { createIngestWriter } from "./ingest-writer";
import { assertWrite, writeFixture } from "./write.test-fixture";

suiteFor(
  "database",
  "valkey",
  "clickhouse",
)("Pulse ClickHouse write identity", () => {
  beforeAll(installFixtureStore, 30000);
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
