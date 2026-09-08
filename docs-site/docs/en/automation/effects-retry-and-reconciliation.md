---
title: Effects, retry, and reconciliation
navTitle: Effects and retry
section: Automation
order: 710
description: Make external side effects recoverable when workflow steps retry or workers crash.
tags: [workflows, effects, retry]
updated: 2026-08-05
---

# Effects, retry, and reconciliation

Choose an effect class before writing an action. The class tells the kernel what
is safe after a crash.

## Use the action context

Every hook receives:

| Field | Use |
| --- | --- |
| `runId`, `stepKey` | Correlation and stable step identity |
| `invocation` | Inputs, context, and frozen actor |
| `effectKey` | Idempotency key stable across replays |
| `tx` | Transaction for a transactional action |
| `binding()` | Stable IDs pinned during publication |
| `resolveReference()` | Values produced by inputs and earlier steps |
| `heartbeat()` | Keep a long action's lease alive |

Transactional work must use `ctx.tx`. An ambient database connection breaks the
atomic journal guarantee.

Idempotent external work must pass `ctx.effectKey` to the provider or its own
deduplication store.

Run `authorize` immediately before an effect when access may have changed. See
[Resource authorization](/en/docs/identity/authorization).

## Return an action result

An action returns one state:

- `succeeded` with output;
- `failed` with message, optional code, and optional retryable flag;
- `waiting` with a durable dependency;
- `ambiguous` when an external effect may already have happened.

Use a stable error code for operator diagnosis. `retryable: true` retries the
run instead of ending it. On the next claim, the journal restores completed
steps and execution returns to the failed step.

Return `waiting` only before any effect happens. If an effect might have
happened, return `ambiguous`.

## Reconcile ambiguous effects

The kernel marks an ambiguous effect before calling the provider. A crash can
leave it without a recorded answer.

On replay, the kernel calls the action's `reconcile` hook. It returns
`succeeded`, `failed`, or `unknown`.

An unknown effect moves the run to `needs_attention`. An operator must resolve
it. The kernel never repeats an effect that may already have happened.

See [Workflow observability and testing](/en/docs/automation/workflow-observability-and-testing#resolve-a-run-that-needs-attention)
for the resolution API.

## Understand recovery

| Situation | Kernel behavior |
| --- | --- |
| Action returns a non-retryable failure | Ends the run as failed |
| Action returns a retryable failure | Releases the run, waits with backoff, and resumes from the journal |
| Worker crashes or loses its lease | Another worker reclaims the run after lease expiry and resumes from the journal |
| Action returns `waiting` | Parks the run until its dependency or deadline wakes it |
| Ambiguous effect cannot be reconciled | Ends the run as `needs_attention` without repeating the effect |
| Cancellation is requested | Cancels queued and waiting runs immediately; a running worker stops at a heartbeat |

Shared workflow AI tasks also observe the parent run's cancellation. Queued
tasks become canceled, running provider calls receive an abort signal, and a
late provider result is discarded instead of waking the run with stale output.

Repeated crashes and retryable failures are bounded. After the exported
`WORKFLOW_RUN_MAX_CONSECUTIVE_FAILURES` limit, the worker records
`WORKFLOW_RETRY_EXHAUSTED`.

Heartbeat long-running actions before the exported `WORKFLOW_RUN_LEASE_MS`
expires. Lease loss fences the old worker from writing a result.

```ts
import {
  WORKFLOW_RUN_LEASE_MS,
  WORKFLOW_RUN_MAX_CONSECUTIVE_FAILURES,
} from "@k2b/cloud/workflows/store";
```

## Plan and charge effects

Non-pure actions implement `plan()`:

```ts
plan: async (_ctx, input) => ({
  summary: `Email ${input.to}`,
  consumes: { emails: 1 },
  output: { messageId: "planned", planned: true },
})
```

The same plan drives dry runs and execution budgets. Synthetic outputs must say
that they are planned.

Publication can set an `effectBudget`. The kernel charges the root run, so
fan-out cannot multiply an allowed effect count.

AI actions consume `maxAiCalls`. A replay of an already-created durable AI task
does not charge that unit again.

## Wait for a dependency

```ts
return {
  state: "waiting",
  dependency: {
    kind: "inventory.approval",
    key: approvalId,
    deadline,
  },
};
```

When the dependency occurs:

```ts
await wakeWorkflowRunsWaitingOn({
  appId: "inventory",
  kind: "inventory.approval",
  key: approvalId,
});
```

The signal is durable and safe around the race between parking and waking.
Keys must identify one occurrence inside the app.

## Fan out with child runs

Use `createChildWorkflowRuns()` for bounded parallel work. A child is a normal
run with its own lease, journal, and status.

Read aggregate progress with `countChildWorkflowRuns()`. Do not create a second
targets engine in the application.

Keep fan-out within the plan's loop and effect budgets. Large unbounded fan-out
can overload every worker even when each child is valid.
