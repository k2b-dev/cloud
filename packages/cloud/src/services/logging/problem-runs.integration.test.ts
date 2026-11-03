import { afterAll, beforeAll, expect, jest, spyOn, test } from "bun:test";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrate } from "../../../../core/src/migrate/core/logging";
import { sql } from "../../runtime/clients";
import { flushSyncTraceEvents, observeSyncEvent, SYNC_SLOW_AFTER_MS, trace, traceSyncEvent } from "./trace";

const suite = databaseSuite();
const at = new Date("2026-11-02T12:00:00Z");
suite("problem-only background tracing", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    database = await useFreshDatabase("problem_runs");
    await migrate();
  });
  afterAll(async () => {
    await flushSyncTraceEvents({ stopping: true });
    await database?.drop();
  });

  test("G5: 1000 successful jobs write 0 spans and one aggregate update", async () => {
    await sql`CREATE TABLE logging.write_probe (kind text)`;
    await sql
      .unsafe(`CREATE FUNCTION logging.count_writes() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO logging.write_probe VALUES (TG_TABLE_NAME); RETURN NEW; END $$`)
      .simple();
    await sql`CREATE TRIGGER count_spans AFTER INSERT OR UPDATE ON logging.trace_spans FOR EACH ROW EXECUTE FUNCTION logging.count_writes()`;
    await sql`CREATE TRIGGER count_minutes AFTER INSERT OR UPDATE ON logging.run_minutes FOR EACH ROW EXECUTE FUNCTION logging.count_writes()`;
    try {
      for (let i = 0; i < 1000; i++) {
        const detail = { id: `job-${i}`, key: "import", attempt: 1 };
        observeSyncEvent({ at, kind: "job", resource: "success", type: "handler_started", detail }, "test");
        // An application's same-key wrapper must not race into an eager insert.
        await trace.withSpan(
          { name: "import", source: "success", spanKey: trace.syncSpanKey("job", "success", detail.id), category: "job" },
          async () => 1,
        );
        observeSyncEvent(
          { at, kind: "job", resource: "success", type: "handler_settled", detail: { ...detail, status: "success", durationMs: 10 } },
          "test",
        );
      }
      await flushSyncTraceEvents();
      expect(await sql`SELECT 1 FROM logging.trace_spans WHERE source = 'success'`).toHaveLength(0);
      const [minute] = await sql<
        Array<{ run_count: string; total_duration_ms: number; max_duration_ms: number }>
      >`SELECT * FROM logging.run_minutes WHERE source = 'success'`;
      expect(Number(minute?.run_count)).toBe(1000);
      expect(minute?.total_duration_ms).toBe(10_000);
      expect(minute?.max_duration_ms).toBe(10);
      const writes = await sql<Array<{ kind: string }>>`SELECT kind FROM logging.write_probe`;
      expect(writes).toEqual([{ kind: "run_minutes" }]);
    } finally {
      await sql`DROP TRIGGER count_spans ON logging.trace_spans`;
      await sql`DROP TRIGGER count_minutes ON logging.run_minutes`;
      await sql`DROP FUNCTION logging.count_writes()`;
      await sql`DROP TABLE logging.write_probe`;
    }
  });

  test("an in-flight run becomes visible exactly at the existing slow budget", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(at);
    try {
      observeSyncEvent({ at, kind: "job", resource: "hanging", type: "handler_started", detail: { id: "active", attempt: 1 } }, "test");
      jest.advanceTimersByTime(SYNC_SLOW_AFTER_MS - 1);
      await flushSyncTraceEvents();
      expect(await sql`SELECT 1 FROM logging.trace_spans WHERE source = 'hanging'`).toHaveLength(0);
      jest.advanceTimersByTime(1);
      await flushSyncTraceEvents();
      const [row] = await sql<
        Array<{ started_at: Date; ended_at: Date | null }>
      >`SELECT started_at, ended_at FROM logging.trace_spans WHERE source = 'hanging'`;
      expect(row?.started_at).toEqual(at);
      expect(row?.ended_at).toBeNull();
      await traceSyncEvent(
        {
          at: new Date(at.getTime() + SYNC_SLOW_AFTER_MS),
          kind: "job",
          resource: "hanging",
          type: "handler_settled",
          detail: { id: "active", attempt: 1, status: "success", durationMs: SYNC_SLOW_AFTER_MS },
        },
        "test",
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test("1024 runs without settlement never prevent fresh slow-start detection", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(at);
    try {
      for (let i = 0; i < 1024; i++) {
        observeSyncEvent(
          { at, kind: "job", resource: "abandoned", type: "handler_started", detail: { id: `old-${i}`, attempt: 1 } },
          "test",
        );
      }
      const warning = spyOn(console, "error").mockImplementation(() => undefined);
      try {
        observeSyncEvent({ at, kind: "job", resource: "abandoned", type: "handler_started", detail: { id: "fresh", attempt: 1 } }, "test");
        expect(warning).toHaveBeenCalledTimes(1);
      } finally {
        warning.mockRestore();
      }
      // Settle the other observations before their timers fire. The guard is
      // admission of fresh work at capacity, not 1024 diagnostic SQL writes.
      for (let i = 1; i < 1024; i++) {
        await traceSyncEvent(
          {
            at,
            kind: "job",
            resource: "abandoned",
            type: "handler_settled",
            detail: { id: `old-${i}`, attempt: 1, status: "success", durationMs: 1 },
          },
          "test",
        );
      }
      jest.advanceTimersByTime(SYNC_SLOW_AFTER_MS);
      await flushSyncTraceEvents();
      const [fresh] = await sql<Array<{ started_at: Date; ended_at: Date | null }>>`
        SELECT started_at, ended_at FROM logging.trace_spans WHERE span_key = ${trace.syncSpanKey("job", "abandoned", "fresh")}`;
      expect(fresh?.started_at).toEqual(at);
      expect(fresh?.ended_at).toBeNull();
      expect(await sql`SELECT 1 FROM logging.trace_spans WHERE span_key = ${trace.syncSpanKey("job", "abandoned", "old-0")}`).toHaveLength(
        0,
      );
      expect(await sql`SELECT 1 FROM logging.trace_spans WHERE source = 'abandoned'`).toHaveLength(1);
    } finally {
      await flushSyncTraceEvents({ stopping: true });
      jest.useRealTimers();
    }
  });

  test("success read returns whole-window counts separately from paginated minutes", async () => {
    // Align this fixture to the database clock used by the read predicate;
    // its outcome is independent of the calendar day on which CI runs.
    await sql`UPDATE logging.run_minutes SET bucket = date_trunc('minute', now()) WHERE source = 'success'`;
    const result = await trace.successMinutes({ page: 1, perPage: 1, offset: 0 }, { filter: { source: "success" } });
    expect(result).toMatchObject({ total: 1, count: 1000, avgDurationMs: 10, maxDurationMs: 10, p95DurationMs: 16 });
    expect(result.minutes).toHaveLength(1);
    const next = await trace.successMinutes({ page: 2, perPage: 1, offset: 1 }, { filter: { source: "success" } });
    expect(next).toMatchObject({ total: 1, count: 1000, minutes: [] });
    const sources = await trace.sourceGroups({ filter: { source: "success" } });
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ source: "success", runs: 0, latestSuccessAt: at.toISOString() });
    const failed = await trace.successMinutes({ page: 1, perPage: 1, offset: 0 }, { filter: { source: "success", status: "error" } });
    expect(failed.count).toBe(0);
  });

  test("failures, retries and runs at the delivery budget retain one span each", async () => {
    for (const [id, status, durationMs] of [
      ["failure", "dead_letter", 1],
      ["retry", "retry", 1],
      ["slow", "success", SYNC_SLOW_AFTER_MS],
    ] as const) {
      await traceSyncEvent({ at, kind: "job", resource: "problems", type: "handler_started", detail: { id, attempt: 1 } }, "test");
      await traceSyncEvent(
        { at, kind: "job", resource: "problems", type: "handler_settled", detail: { id, attempt: 1, status, durationMs } },
        "test",
      );
    }
    expect(await sql`SELECT 1 FROM logging.trace_spans WHERE source = 'problems'`).toHaveLength(3);
    await flushSyncTraceEvents();
    const [slowCount] = await sql<
      Array<{ count: string }>
    >`SELECT SUM(run_count)::text AS count FROM logging.run_minutes WHERE source = 'problems'`;
    expect(Number(slowCount?.count)).toBe(1);
    await traceSyncEvent({ at, kind: "job", resource: "problems", type: "handler_started", detail: { id: "retry", attempt: 2 } }, "test");
    const [activeRetry] = await sql<
      Array<{ ended_at: Date | null }>
    >`SELECT ended_at FROM logging.trace_spans WHERE span_key = ${trace.syncSpanKey("job", "problems", "retry")}`;
    expect(activeRetry?.ended_at).toBeNull();
    await traceSyncEvent(
      {
        at,
        kind: "job",
        resource: "problems",
        type: "handler_settled",
        detail: { id: "retry", attempt: 2, status: "success", durationMs: 1 },
      },
      "test",
    );
    const [retry] = await sql<
      Array<{ status: string }>
    >`SELECT status FROM logging.trace_spans WHERE span_key = ${trace.syncSpanKey("job", "problems", "retry")}`;
    expect(retry?.status).toBe("ok");
    await flushSyncTraceEvents();
    const [recoveredCount] = await sql<
      Array<{ count: string }>
    >`SELECT SUM(run_count)::text AS count FROM logging.run_minutes WHERE source = 'problems'`;
    expect(Number(recoveredCount?.count)).toBe(2);
    expect(await sql`SELECT 1 FROM logging.trace_spans WHERE source = 'problems'`).toHaveLength(3);
  });

  test("byte retention deletes closed spans and their events while preserving open spans", async () => {
    const closed = await trace.start({ source: "size", name: "closed", startedAt: at });
    await trace.record({ context: closed, event: "error", severity: "error", body: "x".repeat(4000) });
    await trace.end({ context: closed, endedAt: at, status: "error" });
    const open = await trace.start({ source: "size", name: "active", startedAt: at });
    const [size] = await sql<
      Array<{ bytes: number }>
    >`SELECT pg_column_size(ROW(s.*))::int AS bytes FROM logging.trace_spans s WHERE trace_id = ${open.traceId}`;
    // A very long day window makes this a byte-budget test regardless of date.
    expect(await trace.cleanup({ source: "size", days: 365_000, maxBytes: size!.bytes })).toBe(1);
    expect(await trace.getSpan(closed)).toBeNull();
    expect(await trace.getSpan(open)).not.toBeNull();
    expect(await sql`SELECT 1 FROM logging.trace_events WHERE trace_id = ${closed.traceId}`).toHaveLength(0);
  });
});
