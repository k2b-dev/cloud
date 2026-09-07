import { describe, expect, test } from "bun:test";
import type { SyncEvent } from "@k2b/sync";
import { sql } from "bun";
import { flushSyncTraceEvents, observeSyncEvent, trace, traceSyncEvent } from "./trace";

const canUseTraceDatabase = async (): Promise<boolean> => {
  try {
    const [row] = await sql<{ spans: string | null; events: string | null }[]>`
      SELECT
        to_regclass('logging.trace_spans')::text AS spans,
        to_regclass('logging.trace_events')::text AS events
    `;
    return Boolean(row?.spans && row.events);
  } catch {
    return false;
  }
};

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = (await canUseTraceDatabase()) ? describe : describe.skip;

const syncEvent = (event: Omit<SyncEvent, "at"> & { at?: Date }): SyncEvent => ({ at: new Date(), ...event });

suite("logging.trace", () => {
  test("queued observer preserves an immediate handler summary and domain presentation", async () => {
    const resource = `test-observer-${crypto.randomUUID()}`;
    const id = crypto.randomUUID();
    const spanKey = trace.syncSpanKey("job", resource, id);
    try {
      observeSyncEvent(syncEvent({ type: "handler_started", resource, kind: "job", detail: { id, attempt: 1 } }), "test-app");
      await trace.end({ spanKey, summary: { immediate: true } });
      await trace.withSpan(
        { name: "Domain operation", source: resource, category: "job", kind: "consumer", spanKey },
        async () => ({ rows: 4 }),
        { summarize: (result) => result },
      );
      observeSyncEvent(
        syncEvent({ type: "handler_settled", resource, kind: "job", detail: { id, status: "retry", attempt: 1 } }),
        "test-app",
      );
      observeSyncEvent(syncEvent({ type: "handler_started", resource, kind: "job", detail: { id, attempt: 2 } }), "test-app");
      observeSyncEvent(
        syncEvent({ type: "handler_settled", resource, kind: "job", detail: { id, status: "success", attempt: 2 } }),
        "test-app",
      );
      await flushSyncTraceEvents();
      const result = await trace.list({ page: 1, perPage: 10, offset: 0 }, { filter: { source: resource } });
      expect(result.total).toBe(1);
      expect(result.spans[0]).toMatchObject({
        name: "Domain operation",
        appId: "test-app",
        status: "ok",
        summary: { immediate: true, rows: 4 },
      });
      expect(result.spans[0]?.attributes).toMatchObject({ "sync.attempt": 2 });
    } finally {
      await flushSyncTraceEvents();
      await sql`DELETE FROM logging.trace_spans WHERE source = ${resource}`;
    }
  });

  test("maps one Sync job run across a retry to one span", async () => {
    const resource = `test-job-${crypto.randomUUID()}`;
    const jobId = crypto.randomUUID();
    const startedAt = new Date(Date.now() - 1_000);
    try {
      await traceSyncEvent(
        syncEvent({ type: "handler_started", resource, kind: "job", detail: { id: jobId, key: "task:1", attempt: 1 }, at: startedAt }),
      );
      await traceSyncEvent(
        syncEvent({
          type: "handler_settled",
          resource,
          kind: "job",
          detail: { id: jobId, key: "task:1", attempt: 1, status: "retry", durationMs: 5 },
        }),
      );
      const midway = await trace.list({ page: 1, perPage: 10, offset: 0 }, { filter: { source: resource } });
      expect(midway.spans[0]).toMatchObject({ status: "error", endedAt: null });

      await traceSyncEvent(syncEvent({ type: "handler_started", resource, kind: "job", detail: { id: jobId, key: "task:1", attempt: 2 } }));
      await traceSyncEvent(
        syncEvent({
          type: "handler_settled",
          resource,
          kind: "job",
          detail: { id: jobId, key: "task:1", attempt: 2, status: "success", durationMs: 7 },
        }),
      );

      const result = await trace.list({ page: 1, perPage: 10, offset: 0 }, { filter: { source: resource, category: "job" } });
      expect(result.total).toBe(1);
      expect(result.spans[0]).toMatchObject({
        name: resource,
        source: resource,
        spanKey: trace.syncSpanKey("job", resource, jobId),
        category: "job",
        kind: "consumer",
        status: "ok",
        eventCount: 1,
      });
      expect(result.spans[0]?.attributes).toMatchObject({
        "sync.kind": "job",
        "sync.resource": resource,
        "sync.id": jobId,
        "sync.key": "task:1",
        "sync.attempt": 2,
      });
      expect(result.spans[0]?.durationMs).toBeGreaterThanOrEqual(1_000);
      const events = await trace.events({ traceId: result.spans[0]!.traceId, spanId: result.spans[0]!.spanId });
      expect(events.map((event) => event.name)).toEqual(["sync.retry"]);
    } finally {
      await sql`DELETE FROM logging.trace_spans WHERE source = ${resource}`;
    }
  });

  test("records dead letters on the run span and names schedule runs after the schedule", async () => {
    const queue = `test-queue-${crypto.randomUUID()}`;
    const scheduler = `test-scheduler-${crypto.randomUUID()}`;
    const messageId = crypto.randomUUID();
    try {
      await traceSyncEvent(syncEvent({ type: "handler_started", resource: queue, kind: "queue", detail: { id: messageId, attempt: 5 } }));
      await traceSyncEvent(
        syncEvent({
          type: "handler_settled",
          resource: queue,
          kind: "queue",
          detail: { id: messageId, attempt: 5, status: "dead_letter", durationMs: 3 },
        }),
      );
      await traceSyncEvent(
        syncEvent({ type: "dead_letter", resource: queue, kind: "queue", detail: { messageId, reason: "max attempts exhausted" } }),
      );
      await traceSyncEvent(syncEvent({ type: "redelivery", resource: queue, kind: "queue", detail: { attempt: 2 } }));

      const runs = await trace.list({ page: 1, perPage: 10, offset: 0 }, { filter: { source: queue, category: "job" } });
      expect(runs.total).toBe(1);
      expect(runs.spans[0]).toMatchObject({ status: "error", statusMessage: "max attempts exhausted" });
      const events = await trace.events({ traceId: runs.spans[0]!.traceId, spanId: runs.spans[0]!.spanId });
      expect(events.map((event) => event.name)).toEqual(["sync.dead_letter"]);
      expect(events[0]?.attributes).toMatchObject({ "sync.reason": "max attempts exhausted" });

      const redeliveries = await trace.list({ page: 1, perPage: 10, offset: 0 }, { filter: { source: queue, category: "sync" } });
      expect(redeliveries.total).toBe(1);
      expect(redeliveries.spans[0]).toMatchObject({ name: queue, eventCount: 1 });
      expect(redeliveries.spans[0]?.endedAt).not.toBeNull();

      const runId = `nightly:2026-09-07T02:00:00.000Z`;
      await traceSyncEvent(
        syncEvent({ type: "handler_started", resource: scheduler, kind: "scheduler", detail: { id: runId, key: "nightly", attempt: 1 } }),
      );
      await traceSyncEvent(
        syncEvent({
          type: "handler_settled",
          resource: scheduler,
          kind: "scheduler",
          detail: { id: runId, key: "nightly", attempt: 1, status: "success", durationMs: 12 },
        }),
      );
      const schedules = await trace.list({ page: 1, perPage: 10, offset: 0 }, { filter: { source: scheduler } });
      expect(schedules.spans[0]).toMatchObject({
        name: "nightly",
        category: "schedule",
        status: "ok",
        spanKey: trace.syncSpanKey("scheduler", scheduler, runId),
      });
    } finally {
      await sql`DELETE FROM logging.trace_spans WHERE source IN (${queue}, ${scheduler})`;
    }
  });

  test("maps Sync pump run events to one backfill span with a summary", async () => {
    const resource = `test-pump-${crypto.randomUUID()}`;
    const key = `sender-rule:${crypto.randomUUID()}`;
    const spanKey = trace.syncSpanKey("pump", resource, key);
    try {
      await traceSyncEvent(syncEvent({ type: "pump_run_started", resource, kind: "pump", detail: { key } }));
      // App code attaches its own attributes to the same span.
      await trace.start({ name: resource, source: resource, spanKey, category: "backfill", attributes: { "mail.mailbox.id": key } });
      await traceSyncEvent(
        syncEvent({
          type: "pump_run_settled",
          resource,
          kind: "pump",
          detail: { key, status: "completed", dispatched: 2, failureCount: 0, durationMs: 20 },
        }),
      );

      const result = await trace.list(
        { page: 1, perPage: 10, offset: 0 },
        { filter: { source: resource, category: "backfill", attributeEquals: { "mail.mailbox.id": key } } },
      );
      expect(result.total).toBe(1);
      expect(result.spans[0]).toMatchObject({
        name: resource,
        source: resource,
        spanKey,
        category: "backfill",
        status: "ok",
        summary: { status: "completed", dispatched: 2, failureCount: 0 },
      });
      expect(result.spans[0]?.attributes).toMatchObject({ "sync.kind": "pump", "sync.key": key, "sync.dispatched": 2 });

      await traceSyncEvent(
        syncEvent({
          type: "pump_run_settled",
          resource,
          kind: "pump",
          detail: { key, status: "failed", dispatched: 2, failureCount: 3, durationMs: 40, error: "mailbox gone" },
        }),
      );
      expect(await trace.getSpan(result.spans[0]!)).toMatchObject({
        status: "error",
        statusMessage: "mailbox gone",
        summary: { status: "failed" },
      });
    } finally {
      await sql`DELETE FROM logging.trace_spans WHERE source = ${resource}`;
    }
  });

  test("observer ignores unrelated events and never throws", async () => {
    expect(() => observeSyncEvent(syncEvent({ type: "connection", detail: { status: "connected" } }))).not.toThrow();
    expect(() => observeSyncEvent(syncEvent({ type: "handler_started", resource: "x", kind: "job", detail: {} }))).not.toThrow();
    expect(() =>
      observeSyncEvent({ type: "handler_settled", at: new Date(), resource: "x", kind: "job", detail: { id: 1 } }),
    ).not.toThrow();
    await traceSyncEvent(syncEvent({ type: "handler_started", resource: "x", kind: "job", detail: {} }));
    expect(await trace.list({ page: 1, perPage: 1, offset: 0 }, { filter: { source: "x" } })).toMatchObject({ total: 0 });
  });

  test("starts one keyed span safely under concurrency", async () => {
    const suffix = crypto.randomUUID();
    const source = `test:trace:concurrent:${suffix}`;
    const spanKey = `${source}:run`;
    const originalError = console.error;
    const startErrors: string[] = [];
    console.error = (...args: unknown[]) => {
      if (args[0] === "[logging:trace] span start failed:") {
        startErrors.push(args.map(String).join(" "));
        return;
      }
      originalError(...args);
    };

    try {
      const contexts = await Promise.all(Array.from({ length: 50 }, () => trace.start({ name: "Concurrent trace test", source, spanKey })));
      expect(startErrors).toEqual([]);
      expect(new Set(contexts.map((context) => `${context.traceId}:${context.spanId}`)).size).toBe(1);

      const [stored] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM logging.trace_spans
        WHERE span_key = ${spanKey}
      `;
      expect(stored?.count).toBe(1);
    } finally {
      console.error = originalError;
      await sql`DELETE FROM logging.trace_spans WHERE source = ${source}`;
    }
  });

  test("records span events and redacts sensitive metadata", async () => {
    const suffix = crypto.randomUUID();
    const source = `test:trace:${suffix}`;
    const spanKey = `test:trace:${suffix}`;
    const span = await trace.start({
      name: "Trace test",
      source,
      spanKey,
      attributes: { apiKey: "secret", safe: "ok" },
    });

    try {
      await trace.record({
        context: span,
        event: "test.step",
        attributes: { accessToken: "token", count: 1 },
      });
      await trace.end({
        context: span,
        status: "ok",
        summary: { password: "secret", kept: "yes" },
      });

      const result = await trace.list({ page: 1, perPage: 10, offset: 0 }, { filter: { source, search: spanKey } });
      expect(result.total).toBe(1);
      expect(result.spans[0]).toMatchObject({
        spanKey,
        status: "ok",
        eventCount: 1,
      });
      expect(result.spans[0]?.attributes).toMatchObject({ apiKey: "[REDACTED]", safe: "ok" });
      expect(result.spans[0]?.summary).toMatchObject({ password: "[REDACTED]", kept: "yes" });

      const events = await trace.events({ traceId: span.traceId, spanId: span.spanId });
      expect(events).toHaveLength(1);
      expect(events[0]?.attributes).toMatchObject({ accessToken: "[REDACTED]", count: 1 });

      const groups = await trace.sourceGroups({ filter: { source } });
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ source, runs: 1, failed: 0 });

      const stats = await trace.stats({ filter: { source } });
      expect(stats).toMatchObject({ runs: 1, sources: 1, failed: 0 });

      const fetched = await trace.getSpan({ traceId: span.traceId, spanId: span.spanId });
      expect(fetched?.spanKey).toBe(spanKey);
    } finally {
      await sql`DELETE FROM logging.trace_spans WHERE source = ${source}`;
    }
  });

  test("persists completed spans in one operation", async () => {
    const suffix = crypto.randomUUID();
    const source = `test:trace:complete:${suffix}`;
    const startedAt = Date.now() - 250;

    try {
      const context = await trace.complete({
        name: "Completed trace test",
        source,
        status: "error",
        statusMessage: "Expected test failure",
        attributes: { apiKey: "secret", safe: "ok" },
        summary: { password: "secret", kept: "yes" },
        startedAt,
        endedAt: startedAt + 250,
      });

      const stored = await trace.getSpan(context);
      expect(stored).toMatchObject({
        name: "Completed trace test",
        source,
        status: "error",
        statusMessage: "Expected test failure",
        eventCount: 0,
        durationMs: 250,
      });
      expect(stored?.attributes).toMatchObject({ apiKey: "[REDACTED]", safe: "ok" });
      expect(stored?.summary).toMatchObject({ password: "[REDACTED]", kept: "yes" });
    } finally {
      await sql`DELETE FROM logging.trace_spans WHERE source = ${source}`;
    }
  });

  test("source groups keep latest status separate from window error stats", async () => {
    const suffix = crypto.randomUUID();
    const source = `test:trace:latest:${suffix}`;
    const now = Date.now();
    const failedSpan = await trace.start({
      name: "Older failed run",
      source,
      spanKey: `test:trace:latest:${suffix}:failed`,
      startedAt: now - 60_000,
    });
    const healthySpan = await trace.start({
      name: "Latest healthy run",
      source,
      spanKey: `test:trace:latest:${suffix}:healthy`,
      startedAt: now,
    });

    try {
      await trace.end({ context: failedSpan, status: "error", endedAt: now - 59_500 });
      await trace.end({ context: healthySpan, status: "ok", endedAt: now + 500 });

      const groups = await trace.sourceGroups({ filter: { source } });

      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({
        source,
        runs: 2,
        failed: 1,
        errorRate: 50,
        latestName: "Latest healthy run",
        latestStatus: "ok",
      });
    } finally {
      await sql`DELETE FROM logging.trace_spans WHERE source = ${source}`;
    }
  });

  test("cleanup removes only completed traces outside retention", async () => {
    const suffix = crypto.randomUUID();
    const source = `test:trace:cleanup:${suffix}`;
    const old = await trace.start({ name: "Old trace", source, startedAt: Date.now() - 40 * 86_400_000 });
    const recent = await trace.start({ name: "Recent trace", source });
    const running = await trace.start({ name: "Running trace", source, startedAt: Date.now() - 40 * 86_400_000 });

    try {
      await trace.end({ context: old, status: "ok", endedAt: Date.now() - 39 * 86_400_000 });
      await trace.end({ context: recent, status: "ok" });

      expect(await trace.cleanup({ days: 30, source })).toBe(1);
      expect(await trace.getSpan({ traceId: old.traceId, spanId: old.spanId })).toBeNull();
      expect(await trace.getSpan({ traceId: recent.traceId, spanId: recent.spanId })).not.toBeNull();
      expect(await trace.getSpan({ traceId: running.traceId, spanId: running.spanId })).not.toBeNull();
    } finally {
      await sql`DELETE FROM logging.trace_spans WHERE source = ${source}`;
    }
  });
});
