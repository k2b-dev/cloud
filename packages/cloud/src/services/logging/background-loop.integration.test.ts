import { expect, spyOn, test } from "bun:test";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";
import { flushSyncTraceEvents, observeSyncEvent, trace } from "./trace";

const suite = databaseSuite();
const at = new Date("2026-11-01T12:00:00Z");
suite("background loop trace emission", () => {
  test("successful idle and work attempts write no spans; retries and errors stay visible", async () => {
    const resource = `test-background-${crypto.randomUUID()}`;
    const key = "reconcile";
    let count = 0;
    let failure = false;
    const handler = trace.backgroundSchedule(
      resource,
      key,
      async () => {
        if (failure) throw new Error("provider unavailable");
        return count;
      },
      (changed) => (changed > 0 ? { changed } : null),
    );
    const run = async (id: string, attempt = 1) => {
      observeSyncEvent({ at, type: "handler_started", kind: "scheduler", resource, detail: { id, key, attempt } });
      let status = "success";
      try {
        await handler({
          scheduleId: key,
          runId: id,
          runNumber: 1,
          slot: at,
          trigger: "schedule",
          attempt,
          signal: new AbortController().signal,
          heartbeat: async () => undefined,
        });
      } catch {
        status = "retry";
      }
      observeSyncEvent({
        at: new Date(at.getTime() + 10),
        type: "handler_settled",
        kind: "scheduler",
        resource,
        detail: { id, key, attempt, status, durationMs: 10 },
      });
      await flushSyncTraceEvents();
    };
    // Private probe names cannot collide with leftovers or parallel test runs.
    const probe = `background_probe_${crypto.randomUUID().replaceAll("-", "")}`;
    await sql.unsafe(`CREATE TABLE logging.${probe} (span_key text)`);
    await sql
      .unsafe(`CREATE FUNCTION logging.${probe}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.source = '${resource}' THEN INSERT INTO logging.${probe} VALUES (NEW.span_key); END IF;
        RETURN NEW;
      END $$`)
      .simple();
    await sql.unsafe(`CREATE TRIGGER ${probe} AFTER INSERT OR UPDATE ON logging.trace_spans
      FOR EACH ROW EXECUTE FUNCTION logging.${probe}()`);
    try {
      await run("idle");
      expect(await sql`SELECT 1 FROM logging.trace_spans WHERE source = ${resource}`).toHaveLength(0);
      expect(await sql.unsafe(`SELECT 1 FROM logging.${probe}`)).toHaveLength(0);
      count = 3;
      await run("work");
      expect(await sql`SELECT 1 FROM logging.trace_spans WHERE source = ${resource}`).toHaveLength(0);
      expect(await sql.unsafe(`SELECT 1 FROM logging.${probe}`)).toHaveLength(0);
      const [counts] = await sql<
        { count: string }[]
      >`SELECT SUM(run_count)::text AS count FROM logging.run_minutes WHERE source = ${resource}`;
      expect(Number(counts?.count)).toBe(2);
      failure = true;
      await run("failed");
      const [failed] = await sql<{ status: string; event_count: number }[]>`
        SELECT span.status, (SELECT count(*)::int FROM logging.trace_events event WHERE event.trace_id = span.trace_id AND event.span_id = span.span_id) AS event_count FROM logging.trace_spans span WHERE span_key = ${trace.syncSpanKey("scheduler", resource, "failed")}`;
      expect(failed).toMatchObject({ status: "error", event_count: 1 });
      failure = false;
      count = 0;
      await run("failed", 2);
      const [recovered] = await sql<{ status: string; event_count: number }[]>`
        SELECT span.status, (SELECT count(*)::int FROM logging.trace_events event WHERE event.trace_id = span.trace_id AND event.span_id = span.span_id) AS event_count FROM logging.trace_spans span WHERE span_key = ${trace.syncSpanKey("scheduler", resource, "failed")}`;
      expect(recovered).toMatchObject({ status: "ok", event_count: 1 });
      // All schedules share the problem-only policy, including neighbors.
      observeSyncEvent({ at, type: "handler_started", kind: "scheduler", resource, detail: { id: "neighbor", key: "other", attempt: 1 } });
      observeSyncEvent({
        at,
        type: "handler_settled",
        kind: "scheduler",
        resource,
        detail: { id: "neighbor", key: "other", attempt: 1, status: "success", durationMs: 1 },
      });
      await flushSyncTraceEvents();
      expect(
        await sql`SELECT 1 FROM logging.trace_spans WHERE span_key = ${trace.syncSpanKey("scheduler", resource, "neighbor")}`,
      ).toHaveLength(0);
    } finally {
      await flushSyncTraceEvents();
      await sql.unsafe(`DROP TRIGGER ${probe} ON logging.trace_spans`);
      await sql.unsafe(`DROP FUNCTION logging.${probe}()`);
      await sql.unsafe(`DROP TABLE logging.${probe}`);
      await sql`DELETE FROM logging.trace_spans WHERE source = ${resource}`;
      await sql`DELETE FROM logging.run_minutes WHERE source = ${resource}`;
    }
  });

  test("background jobs complete while trace SQL is pending and retain Sync identity", async () => {
    const resource = `test-background-job-${crypto.randomUUID()}`;
    const id = "job-run";
    const key = "folder:example";
    const handler = trace.backgroundJob<null, number>(
      resource,
      async () => 2,
      (changed) => ({ changed }),
    );
    const context = {
      jobId: id,
      key,
      input: null,
      attempt: 1,
      failureCount: 0,
      signal: new AbortController().signal,
      heartbeat: async () => undefined,
      resubmit: () => undefined,
    };
    const connection = await sql.reserve();
    let completion: Promise<void> | undefined;
    try {
      await connection`BEGIN`;
      // The integration preload gives this file its own database. Hold writes,
      // then race handler completion against an independent database round trip.
      await connection`LOCK TABLE logging.run_minutes IN SHARE MODE`.simple();
      observeSyncEvent({ at, type: "handler_started", kind: "job", resource, detail: { id, key, attempt: 1 } });
      completion = handler(context);
      expect(await Promise.race([completion.then(() => "completed"), sql`SELECT 1`.then(() => "still pending")])).toBe("completed");
      observeSyncEvent({
        at,
        type: "handler_settled",
        kind: "job",
        resource,
        detail: { id, key, attempt: 1, status: "success", durationMs: 1 },
      });
      let flushed = false;
      const flush = flushSyncTraceEvents().then(() => {
        flushed = true;
      });
      await sql`SELECT 1`;
      expect(flushed).toBe(false);
      expect(await sql`SELECT 1 FROM logging.trace_spans WHERE source = ${resource}`).toHaveLength(0);
      await connection`ROLLBACK`;
      await flush;
      const [minute] = await sql<
        { source: string; run_count: string }[]
      >`SELECT source, run_count FROM logging.run_minutes WHERE source = ${resource}`;
      expect(minute?.source).toBe(resource);
      expect(Number(minute?.run_count)).toBe(1);
      expect(await sql`SELECT 1 FROM logging.trace_spans WHERE source = ${resource}`).toHaveLength(0);
    } finally {
      await connection`ROLLBACK`;
      connection.release();
      await completion;
      await flushSyncTraceEvents();
      await sql`DELETE FROM logging.trace_spans WHERE source = ${resource}`;
      await sql`DELETE FROM logging.run_minutes WHERE source = ${resource}`;
    }
  });

  test("retry summaries never wait for the trace database", async () => {
    const resource = `test-background-retry-${crypto.randomUUID()}`;
    const detail = { id: "retry", key: "reconcile", attempt: 2 };
    const handler = trace.backgroundSchedule(
      resource,
      detail.key,
      async () => 1,
      (changed) => ({ changed }),
    );
    const connection = await sql.reserve();
    try {
      await connection`BEGIN`;
      await connection`LOCK TABLE logging.trace_spans IN SHARE MODE`.simple();
      observeSyncEvent({ at, type: "handler_started", kind: "scheduler", resource, detail });
      const completed = handler({
        scheduleId: detail.key,
        runId: detail.id,
        runNumber: 1,
        slot: at,
        trigger: "schedule",
        attempt: 2,
        signal: new AbortController().signal,
        heartbeat: async () => undefined,
      });
      expect(await Promise.race([completed.then(() => "completed"), sql`SELECT 1`.then(() => "blocked")])).toBe("completed");
      observeSyncEvent({
        at,
        type: "handler_settled",
        kind: "scheduler",
        resource,
        detail: { ...detail, status: "success", durationMs: 1 },
      });
      await connection`ROLLBACK`;
      await flushSyncTraceEvents();
      const [span] = await sql<Array<{ summary: unknown }>>`SELECT summary FROM logging.trace_spans WHERE source = ${resource}`;
      expect(span?.summary).toEqual({ changed: 1 });
    } finally {
      await connection`ROLLBACK`;
      connection.release();
      await flushSyncTraceEvents();
      await sql`DELETE FROM logging.trace_spans WHERE source = ${resource}`;
      await sql`DELETE FROM logging.run_minutes WHERE source = ${resource}`;
    }
  });

  test("summarize exceptions are logged without failing completed work or scheduling a retry", async () => {
    const resource = `test-background-summary-${crypto.randomUUID()}`;
    const key = "summarize";
    let completed = 0;
    const handler = trace.backgroundSchedule(
      resource,
      key,
      async () => ++completed,
      () => {
        throw new Error("summary unavailable");
      },
    );
    const report = spyOn(console, "error").mockImplementation(() => undefined);
    const detail = { id: "completed", key, attempt: 1 };
    try {
      observeSyncEvent({ at, type: "handler_started", kind: "scheduler", resource, detail });
      // A rejection would enter Sync's retry path, repeating the already completed work.
      await expect(
        handler({
          scheduleId: key,
          runId: detail.id,
          runNumber: 1,
          slot: at,
          trigger: "schedule",
          attempt: 1,
          signal: new AbortController().signal,
          heartbeat: async () => undefined,
        }),
      ).resolves.toBeUndefined();
      observeSyncEvent({ at, type: "handler_settled", kind: "scheduler", resource, detail: { ...detail, status: "success" } });
      await flushSyncTraceEvents();
      expect(completed).toBe(1);
      expect(report).toHaveBeenCalledWith("[logging:trace] background summary failed:", "summary unavailable");
      expect(await sql`SELECT 1 FROM logging.trace_spans WHERE source = ${resource}`).toHaveLength(0);
    } finally {
      report.mockRestore();
      await flushSyncTraceEvents();
      await sql`DELETE FROM logging.trace_spans WHERE source = ${resource}`;
      await sql`DELETE FROM logging.run_minutes WHERE source = ${resource}`;
    }
  });
});
