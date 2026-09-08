---
title: Emit events and start runs
navTitle: Start workflow runs
section: Automation
order: 690
description: Start durable workflow runs from domain events or direct application requests.
tags: [workflows, events, workers]
updated: 2026-07-27
---

# Emit events and start runs

Every workflow run starts from an event. A schedule tick, button press, and
domain change use the same durable path.

## Emit an event

```ts
import { emitWorkflowEvent } from "@k2b/cloud/workflows/store";

const emission = await emitWorkflowEvent(
  {
    appId: "inventory",
    scopeId: warehouseId,
    type: "inventory.itemChanged",
    data: { itemId },
    context: { warehouseId },
    authorization: {
      actor: {
        userId: actor.id,
        groupIds: actor.groupIds,
      },
    },
    dedupeKey: `item:${itemId}:${version}`,
  },
  {
    dispatch: "now",
    db: transaction,
  },
);
```

`dispatch: "now"` creates matching runs before returning. Use it when the caller
needs run IDs.

Deferred dispatch records the event and lets a worker create the runs. Use it
for observed occurrences where losing the event would be worse than delaying
dispatch.

When domain state and event must agree, write both in one database transaction.

## Set event fields

| Field | Meaning |
| --- | --- |
| `appId` | Application that owns the event |
| `scopeId` | App-defined isolation boundary |
| `type` | Namespaced event type |
| `data` | Inputs passed to the run |
| `context` | App facts available under workflow context |
| `authorization` | Frozen actor and permission context |
| `dedupeKey` | Stable identity for a repeatable occurrence |
| `occurredAt` | Time the occurrence happened |
| `targetWorkflowId` | Optional restriction to one workflow |

The emitter's authorization wins over the activation fallback. Store the actor
inside `authorization.actor`.

An unknown authorization shape resolves to no actor. The worker does not invent
a system identity.

Repeated emission with the same key records one event and returns the original
run IDs.

## Run a worker

```ts
import {
  createWorkflowActionPort,
  tickWorkflows,
} from "@k2b/cloud/workflows/store";

const actions = createWorkflowActionPort(inventoryWorkflows);

const result = await tickWorkflows({
  worker: process.env.HOSTNAME ?? "inventory-local",
  appId: "inventory",
  module: inventoryWorkflows,
  actions,
  values: (claim) => createInventoryValueResolver(claim),
  trace: inventoryWorkflowTrace,
});
```

Call ticks from a bounded lifecycle loop. Do not start the next tick while the
previous one is running.

Every application worker must pass its `appId` and current module. The app ID
keeps claims scoped to the app. The module prevents an alpha-era version bound
against another language version or manifest from executing; publish that
source again against the current module instead.

The worker dispatches pending events, wakes expired waits, and executes ready
runs. It renews run leases while actions execute.

`values` is a factory because each resolver uses one run's scope and actor.

Create a separate port with `createWorkflowDryRunPort()` and drain it with
`dryRunOneWorkflow()`. A dry run must never enter the execution worker.

See [Workflow observability and testing](/en/docs/automation/workflow-observability-and-testing)
for run inspection and dry-run verification.
