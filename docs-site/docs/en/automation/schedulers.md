---
title: Schedulers
navTitle: Schedulers
section: Automation
order: 630
description: Run recurring work without coupling it to HTTP requests.
tags: [scheduler, cron, sync]
updated: 2026-09-07
---

# Schedulers

Use a scheduler for recurring work shared by application instances. Sync stores
schedules in NATS JetStream. The broker produces ticks while application
processes are offline; workers process retained ticks after startup. Every
instance should register the same schedule definitions and callbacks.

## Register a schedule

```ts
import { lazySync } from "@valentinkolb/cloud";

const inventoryScheduler = lazySync((sync) => sync.scheduler({
  id: "inventory",
  delivery: { maxAttempts: 4, backoffMs: [5_000, 20_000, 60_000] },
}));

await inventoryScheduler().create({
  id: "cleanup",
  cron: "0 * * * *",
  timezone: "UTC",
  misfire: "latest",
  process: async (context) => {
    await deleteExpiredImports(context.slot);
  },
});
const worker = await inventoryScheduler().process();

// During shutdown, before releasing handler dependencies:
worker.stop();
await worker.drain();
```

Register and start workers during application lifecycle startup.
`create()` is idempotent by schedule ID and updates changed definitions. New
schedules created after `process()` starts are served too.

`cron` uses five fields. `timezone` is an IANA zone and defaults to UTC.
`misfire: "latest"` runs only the newest retained missed slot; `"all"` processes
all retained slots. Retention still bounds how far downtime can be recovered.

## Use the run context

| Field | Meaning |
| --- | --- |
| `scheduleId` | Registered schedule |
| `runId` | Run identity |
| `slot` | Cron slot as a `Date` |
| `runNumber` | Persistent increasing run number |
| `attempt` | Delivery attempt, including the first |
| `trigger` | `schedule` or `manual` |
| `signal`, `heartbeat()` | Cancellation and lease renewal |

Use the slot as occurrence identity; using current time changes the meaning of
a delayed run. A thrown error retries according to scheduler-wide `delivery`;
after `maxAttempts`, the slot fails. Schedules execute serially per schedule.
Keep handlers idempotent because a crash can repeat a slot.

For independent per-item retries, submit [jobs](/en/docs/automation/jobs-and-queues#run-a-job).
Schedule handlers do not support job continuations; perform bounded loops with
heartbeats or dispatch jobs.

## Register workflow schedule triggers

Published workflow activations are durable records. The process-local scheduler
handlers must be restored from them after every start:

```ts
import {
  createWorkflowScheduleRegistration,
  reconcileWorkflowSchedules,
} from "@valentinkolb/cloud/workflows/runtime";

const desired = activations.map((activation) =>
  createWorkflowScheduleRegistration({
    namespace: "inventory",
    workflowId: activation.workflowId,
    triggerId: activation.triggerKey,
    revision: String(activation.revision),
    cron: activation.cron,
    timezone: activation.timezone,
  }),
);

await reconcileWorkflowSchedules({
  desired,
  current: await loadRegisteredWorkflowSchedules(),
  port: {
    create: registerWithScheduler,
    update: (_current, next) => registerWithScheduler(next),
    register: registerWithScheduler,
    remove: removeFromScheduler,
  },
});
```

The registration ID stays stable across workflow revisions. A changed revision,
cron expression, or timezone becomes an update. Missing desired registrations
are removed.

`register` also runs for unchanged entries. Use it to restore the callback held
by the current application process.

When a slot fires, emit the workflow event with a deterministic key:

```ts
import {
  workflowScheduleSlotKey,
} from "@valentinkolb/cloud/workflows/runtime";
import {
  emitWorkflowEvent,
} from "@valentinkolb/cloud/workflows/store";

const slot = context.slot.toISOString();

await emitWorkflowEvent({
  appId: "inventory",
  scopeId: warehouseId,
  type: "inventory.schedule",
  targetWorkflowId: registration.workflowId,
  occurredAt: new Date(slot),
  dedupeKey: workflowScheduleSlotKey(registration.id, slot),
});
```

The slot key prevents a redelivery from starting the same workflow twice.
See [Start workflow runs](/en/docs/automation/emit-events-and-start-runs) for
event fields and dispatch behavior.

## Trigger and inspect a run

`runNow({ id, requestId })` durably accepts a manual run without moving the next
cron slot and returns `{ runId }`. Supply a stable request ID to deduplicate
repeated requests. Use `awaitRun({ id, runId, timeoutMs })` when the caller needs
completion rather than acceptance.

`list()` exposes the schedulers declared in the current process. `nextRunAt`
is a `Date`; `handlerAvailable` describes whether this process has the callback.
It does not describe whether another process can execute the schedule. Cloud
discovers scheduler controls automatically through `sync.controls()` for fleet
inspection. The control view combines handler availability across local handles
of the same scheduler without merging their workers or callbacks. No manual
registration or separate scheduler client is needed.

The lifecycle administration health endpoint reports local worker state:
`started`, `registered`, `active`, and `capacity`. It is not a fleet-wide success
count. Use [Tracing](/en/docs/platform/tracing) and application audit records to
inspect outcomes. Handler summaries must be written explicitly; Sync observer
events do not include handler return values.
