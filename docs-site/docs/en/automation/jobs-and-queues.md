---
title: Jobs and queues
navTitle: Jobs and queues
section: Automation
order: 620
description: Run asynchronous work and control how tasks wait for workers.
tags: [jobs, queues, sync]
updated: 2026-09-07
---

# Jobs and queues

Use a job for one typed background operation. Use a queue when the application
needs manual acknowledgement, retry delays, or dead-letter handling. Both use
NATS JetStream through `@k2b/sync` and execute at least once. Keep durable
business state in Postgres and make repeated effects idempotent.

## Retry an operation

`retry()` is process-local and does not survive a restart:

```ts
import { isRetryableTransportError, retry } from "@k2b/sync/retry";

const response = await retry({
  run: () => fetchInventory(),
  after: ({ ctx }) => {
    if (ctx.error && ctx.attempt < 5 && isRetryableTransportError(ctx.error)) {
      ctx.reschedule({ delayMs: ctx.expBackoff() });
    }
  },
  signal,
});
```

Without `reschedule()`, the loop returns the result or throws the original
error. Pass an abort signal when the caller can cancel the work.

## Run a job

Cloud owns one Sync instance per application process. Declare handles with
`lazySync()`; use them from lifecycle startup or request handlers after Cloud
has connected NATS.

```ts
import { lazySync } from "@valentinkolb/cloud";

const reindexItem = lazySync((sync) => sync.job<{ itemId: string }>({
  id: "inventory.reindex-item",
  delivery: {
    ackWaitMs: 60_000,
    maxAttempts: 4,
    backoffMs: [1_000, 5_000, 30_000],
  },
}));

// In lifecycle.start(): explicitly start the consumer, even with no new work.
const worker = await reindexItem().process({ concurrency: 2 }, async (context) => {
  await rebuildIndex(context.input.itemId);
  await context.heartbeat();
});

await reindexItem().submit({
  key: `item:${itemId}`,
  input: { itemId },
  coalesce: true,
});

// In lifecycle.stop(), before releasing handler dependencies:
worker.stop();
await worker.drain();
```

A successful handler acknowledges its delivery. A thrown error retries using
`delivery.backoffMs`; after `maxAttempts`, including the first attempt, it moves
to dead letters. Call `heartbeat()` during long operations before `ackWaitMs`
expires. `concurrency` limits local handlers; `delivery.maxInFlight` limits all
workers sharing the durable consumer.

`key` is required and limited to 96 UTF-8 bytes. By default, it deduplicates
within `dedupeWindowMs` (two minutes). `coalesce: true` instead keeps at most one
queued or running job per key and releases the key after terminal settlement.
Use it when cron scans or boot recovery repeatedly submit unfinished work.
Permanent uniqueness belongs in the application database.

For successful continuation, call `context.resubmit({ delayMs, input })` inside
the handler. It schedules a fresh attempt with the same key; omitted input
keeps the current input. This is suitable for more pages of work, a busy
dependency, or provider throttling that should not consume the failure budget.

`process({ onError }, handler)` can return `{ action: "retry", delayMs }` or
`{ action: "dead_letter", reason }` from `onError`. Write any terminal domain
failure before choosing dead letters. Handle intentional cancellation inside
the handler and return successfully when no work remains.

## Use a queue

```ts
const imports = lazySync((sync) => sync.queue<{ fileId: string }>({
  id: "inventory.imports",
  delivery: { ackWaitMs: 30_000, maxAttempts: 10 },
}));

await imports().send({ data: { fileId }, idempotencyKey: `import:${fileId}` });
const reader = await imports().reader();
try {
  for await (const delivery of reader.stream({ signal })) {
    try {
      await importFile(delivery.data.fileId);
      await delivery.ack();
    } catch (error) {
      await delivery.retry({ delayMs: 5_000, reason: String(error) });
    }
  }
} finally {
  await reader.close();
}
```

Use `queue.process()` for automatic acknowledgement and error retries. Manual
readers support `ack()`, `retry()`, `deadLetter()`, and `heartbeat()`. A final
retry moves the message to dead letters. Settlement failures can throw;
late acknowledgements after redelivery can settle idempotently, so an
acknowledgement is not proof that no other worker ran the handler.

Ordering is enabled explicitly with
`ordering: { mode: "partitioned", partitions: 32 }`. Each send then needs an
`orderingKey`. Retries hold that partition, reducing parallelism for other keys
in it. Manual readers are available only for unpartitioned queues.

Queue retention defaults to seven days and 1 GiB. Retention is a hard loss
boundary: choose a budget that covers queued delays, processing, and retry
windows. Payloads default to 128 KiB including the JSON envelope. Pass large
artifacts through a Sync object store instead of embedding them.

## Recover unfinished work

Start consumers on every process startup. Database recovery scans should
resubmit unfinished records with stable keys and coalescing. Cloud notification
batches recover `ready` and `running` records in bounded pages at startup;
notification delivery also scans pending database records periodically.

Queue and job handles expose `deadLetters.list()`, `requeue()` and `delete()`.
A requeue requires a new idempotency key. Cloud automatically discovers declared
stores through `sync.controls()` for administrative inspection. Queue and job
IDs remain distinct even when their names match. No manual registration is needed; keep
application failure records when users need domain-specific recovery.

Validate untrusted payloads at the application boundary. TypeScript generics
do not provide runtime validation. Use [workflow effects](/en/docs/automation/effects-retry-and-reconciliation)
when a multi-step process needs a durable effect journal.
