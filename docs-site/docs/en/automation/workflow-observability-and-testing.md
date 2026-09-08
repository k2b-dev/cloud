---
title: Workflow observability and testing
navTitle: Workflow testing
section: Automation
order: 730
description: Inspect workflow runs and verify application actions without hiding runtime failures.
tags: [workflows, testing, observability]
updated: 2026-07-27
---

# Workflow observability and testing

Use the shared workflow operations data. Do not build a second run history in
the application.

## Inspect runtime state

Use the shared store instead of creating another run history:

```ts
import {
  getWorkflowRun,
  listWorkflowRuns,
} from "@k2b/cloud/workflows/store";

const runs = await listWorkflowRuns({
  appId: "inventory",
  scopeId: warehouseId,
  includeChildren: false,
  limit: 50,
});

const latest = runs[0];
const detail = latest ? await getWorkflowRun(latest.id) : null;
```

The list filter accepts app, scope, workflow, parent, state, mode, start time,
limit, and offset. Run detail adds inputs, result, source, steps, effect usage,
event data, and child-state counts.

Use run families and timelines for grouped operations views. Use stranded
effects, undispatched events, and application health for recovery queues.

The shared operations UI is at `/admin/observability/workflows`.

The `cld admin workflows` commands cover runs, detail, effects, resolution,
events, and health.

Run states are:

`queued`, `running`, `waiting`, `succeeded`, `failed`, `canceled`, and
`needs_attention`.

Step states use a different vocabulary:

`running`, `completed`, `waiting`, `failed`, `needs_attention`, `terminal`,
`planned`, `unsupported`, `indeterminate`, and `canceled`.

Keep those terms distinct in application UI.

`result` is the workflow output. `resultMessage` is operator-facing status
text. `error` contains failure detail. Do not merge them into one field.

## Cancel a run

```ts
import {
  requestWorkflowRunCancel,
} from "@k2b/cloud/workflows/store";

const changed = await requestWorkflowRunCancel(runId);
```

The request includes child runs. Queued and waiting runs become canceled
immediately. A running worker observes cancellation at its next heartbeat. If
that worker disappears first, the next app tick finalizes the request after
the lease expires. A step with an executing or ambiguous external effect moves
to `needs_attention` instead of being reported as safely canceled.

Authorize the operation in the application service before calling the store.
The store does not know which application user may control a run.

## Resolve a run that needs attention

An ambiguous external effect may have succeeded before its worker crashed.
Verify the provider state before resolving it:

```ts
import {
  listStrandedWorkflowEffects,
  resolveWorkflowRunAttention,
} from "@k2b/cloud/workflows/store";

const effects = await listStrandedWorkflowEffects({
  appId: "inventory",
  olderThanMs: 60_000,
  limit: 100,
});

const effect = effects[0];
if (effect) {
  await resolveWorkflowRunAttention({
    runId: effect.runId,
    stepKey: effect.stepKey,
    resolution: {
      state: "succeeded",
      output: { providerId },
    },
  });
}
```

Confirming success records the step output and queues the remaining plan.
Confirming failure settles both the step and run:

```ts
await resolveWorkflowRunAttention({
  runId,
  stepKey,
  resolution: {
    state: "failed",
    code: "INVENTORY_PROVIDER_REJECTED",
    message: "The provider confirmed that the operation failed.",
  },
});
```

Never use resolution as a generic retry button. Resolve only after checking
whether the effect happened.

## Connect a trace port

The worker trace port receives run and step transitions. Events identify the
run and transition. Read current store state when a consumer needs detail.

Trace delivery is best effort. A trace failure never changes a run outcome.

Map workflow transitions to [Cloud tracing](/en/docs/platform/tracing) when the
deployment needs one operations timeline.

## Test action declarations

Test each action class at its boundary:

- config schema accepts and rejects the expected values;
- `authorize` refuses revoked access;
- `run` returns stable codes for domain failures;
- `plan` reports the same effect cost as execution;
- idempotent actions reuse `effectKey`;
- ambiguous actions reconcile every provider state;
- transactional actions use the supplied transaction.

## Test complete processes

Use the exports from `@k2b/cloud/workflows/testing` to run shared
process fixtures:

```ts
import { expect } from "bun:test";
import {
  directOnlyProcessFixture,
  runWorkflowProcessFixture,
} from "@k2b/cloud/workflows/testing";

const result = await runWorkflowProcessFixture(
  directOnlyProcessFixture,
);

expect(result.execution.state).toBe("succeeded");
```

The fixtures cover direct invocation, launchers, schedules, record events, and
bulk launchers. They verify the application integration against the same
workflow process contract.

Add database integration tests for publication, event deduplication, worker
recovery, waiting, budget limits, and scope deletion.

A dry run is useful product behavior, not a substitute for tests. Verify that
its planned outputs and issues match the real action declarations.
