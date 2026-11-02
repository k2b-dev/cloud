---
title: Tracing
navTitle: Tracing
section: Platform services
order: 540
description: Follow one request across application and platform boundaries.
tags: [tracing, observability, operations]
updated: 2026-11-02
---

# Tracing

Use a trace when several steps belong to one operation.

A trace groups spans and events under one trace ID. It records timing, status,
and safe attributes. Cloud stores the result for the operations interface.

Use [structured logging](/en/docs/platform/logging) for an independent event.
Use a trace for a request, job, schedule, notification, or other operation with
a start and an end.

## Trace an operation

`trace.withSpan()` closes the span on success and records an exception before
closing it on failure:

```ts
import { trace } from "@k2b/cloud/services";

const item = await trace.withSpan(
  {
    name: "inventory.import",
    source: "inventory:import",
    appId: "inventory",
    category: "job",
    attributes: { "inventory.file_id": fileId },
  },
  async (span) => {
    await trace.record({
      context: span,
      event: "inventory.import.validated",
      attributes: { "inventory.row_count": rows.length },
    });
    return importRows(rows);
  },
  {
    summarize: (result) => ({ imported: result.imported }),
  },
);
```

The callback receives `{ traceId, spanId }`. Pass that context to child work
when it belongs to the same operation.

## Automatic background diagnostics

Cloud defers automatic Sync job, queue, topic-consumer, schedule, and pump
spans. A successful first attempt below 30 seconds writes no trace row.
Each process combines successful completions (including slow runs and
recovered retries) by UTC minute, application, source, category, and static operation name in `logging.run_minutes`. It flushes one
batched upsert within a minute and at clean shutdown. The row stores count,
duration sum, maximum, and a fixed duration histogram; it stores no run IDs,
keys, attributes, summaries, or payloads. These are operational counters,
not durable business facts: a process crash or failed diagnostic write can
lose the unflushed minute. Writes are not retried after an ambiguous result.

The 30-second diagnostic threshold comes from Sync 7's default delivery
acknowledgement budget (`ackWaitMs: 30_000`). It is fixed across applications,
including those that extend their delivery lease. It does not mean their
worker lease expired. On reaching the threshold, an in-flight run materializes
its start span with its original start time, so a hanging run remains visible.
Failures, retries, and successful retries retain their detailed span. Explicit
diagnostic events and independent domain/child spans retain their contracts.

Use `trace.syncSpanKey(kind, resource, runId)` to attach presentation or a
summary to the same automatic run. Such a successful run remains deferred;
an explicit diagnostic event materializes it. `trace.backgroundSchedule()`
and `trace.backgroundJob()` still accept a result summarizer. Return `null`
when no summary is useful; a non-null summary enriches a problem trace without
forcing an individual success trace. A summary exception is logged and never
retries completed business work.

```ts
const processDue = trace.backgroundSchedule(
  "inventory", "inventory:due", async () => dispatchDueItems(),
  (dispatched) => dispatched > 0 ? { dispatched } : null,
);
await scheduler.create({ id: "inventory:due", cron: "* * * * *", process: processDue });
```

The observer bounds active deferred runs and pending diagnostic writes to
1,024 each; the minute buffer likewise holds at most 1,024 distinct groups.
At capacity the active-run buffer evicts its oldest observation so missing
settlement events cannot permanently disable slow-start detection for fresh
work. Sync can omit settlement on cancellation; an open diagnostic span alone
does not prove a worker is still running. Pending-write and minute-buffer
overflow reports a warning and drops observations, never domain
work. Slow-start visibility can be incomplete under observer overload; a
settled slow or failed run can still create its span. Normal operation resumes
as entries settle or a minute is flushed. Timers do not keep a process alive.

Platform consumers can read `trace.successMinutes(pagination, { filter })`
for paginated minute rows and whole-selection count, weighted mean, maximum,
and histogram p95. Source, application, category, search, and time filters
apply. Individual duration filters apply to detailed traces only. Histogram
p95 is the upper bound of a power-of-two millisecond bucket, not an exact
sample percentile. `trace.list` and `stats` continue to describe
detailed stored spans. `sourceGroups` also discovers sources that have only
minute counters and supplies `latestSuccessAt`, so a later success can clear
an older failure in the health view. Its run/duration counters describe
retained spans and are zero for a minute-only source. Slow or recovered successful runs appear in both
sets; never add the counters to the trace totals. Percentiles beyond the last
finite histogram bucket (2³¹ ms) are unavailable.

## Choose span fields

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | Yes | Stable operation name |
| `source` | Yes | Stable subsystem such as `inventory:import` |
| `spanKey` | No | Stable key used to resume or update a known span |
| `parent` | No | Parent trace context |
| `appId` | No | Owning application |
| `category` | No | `job`, `schedule`, `backfill`, `ai`, `http`, `notification`, `sync`, or `custom` |
| `kind` | No | `internal`, `server`, `client`, `producer`, or `consumer` |
| `attributes` | No | Structured, sanitized values |
| `startedAt` | No | Explicit start time |

Attributes may contain strings, numbers, booleans, null, and undefined. Keep
names stable and values bounded. Do not attach request bodies or secrets.

## Trace backfills

Use `backfill` for a bounded run that processes existing records, such as
reindexing historical data or applying a rule retroactively. Use `job` for an
individual background operation and `sync` for synchronization activity.
The category labels the trace; it does not schedule work or make it durable.

Cloud classifies Sync pump diagnostics as `backfill`. Fast successful pump
runs use the same minute counters; problems retain spans. Their `name`
and `source` are the pump ID, and `appId` identifies the hosting application.
No application-level observer or additional wrapper span is needed. To attach
events to that run, use `trace.syncSpanKey("pump", pumpId, runKey)` with the
exact key passed to the pump. For a manually traced backfill outside a pump,
set `category: "backfill"` on the normal span API.

Keep metadata limited to safe identifiers and counts. Do not attach scanned
records, account details, tokens, or message contents. Pump completion records
the status, dispatched count, and failure count; a failed pump ends with trace
status `error`. Completion of a producer does not prove that all dispatched
jobs succeeded: inspect their own runs as well.

For example, Core's FreeIPA expiry backfill uses pump source
`auth:ipa:backfill`; its per-account jobs use `auth:ipa:backfill:account`.
See [Observability](/en/docs/operations/observability#inspect-backfills) for
the UI and CLI filters and [FreeIPA recovery](/en/docs/reference/freeipa-recovery)
for that operation's recovery rules.

## Record events

Call `trace.record()` for a meaningful point inside the span. An event accepts
`event`, `severity`, `attributes`, and an optional `body`.

Severities are `debug`, `info`, `warn`, and `error`. Recording an event does not
finish the span.

Calling `record()` without a context or `spanKey` creates and immediately ends
a standalone span. Prefer [logging](/en/docs/platform/logging) when the event
does not need trace semantics.

## Control the lifecycle

Use the lower-level methods when work crosses callbacks or process boundaries:

```ts
const span = await trace.start({
  name: "inventory.export",
  source: "inventory:export",
  category: "job",
});

try {
  await exportInventory();
  await trace.end({ context: span, status: "ok" });
} catch (error) {
  await trace.end({
    context: span,
    status: "error",
    statusMessage: error instanceof Error ? error.message : "Export failed",
  });
  throw error;
}
```

`trace.complete()` stores a span whose start and end are already known. This
avoids two writes on a hot path.

An unfinished span remains active. The operations view treats a span as stuck
after one hour. Always end manually started spans.

## Trace storage and failures

Cloud observes Sync starts, completions, and dead letters automatically and
stores diagnostic spans according to the background policy above. Enrich the
same run with
`trace.syncSpanKey(kind, resourceId, runId)` as the `spanKey`. For a durable
topic handler, also pass the consumer name as the
fourth argument: `trace.syncSpanKey("topic", resourceId, eventId, consumer)`.
Each independent consumer has its own run identity, even when processing the
same event. Use the same key when starting, recording, or ending that span.

Trace writes are operational telemetry. Write failures are reported to the
process console and do not replace application error handling.

Do not use traces as business records. Store domain facts in the application
database. Use [audit events](/en/docs/platform/audit-events) for durable
security evidence.

Topic consumers follow the same failure, retry, and slow-run policy. Fast
successes contribute to the minute counters without multiplying span writes.
