---
title: Application AI tasks
navTitle: Application AI tasks
section: Operations
order: 948
description: Upgrade and operate shared durable inference for application-owned background jobs.
tags: [ai, jobs, migrations]
updated: 2026-10-27
---

# Application AI tasks

Application jobs can use the same durable inference worker as workflow AI,
without creating a workflow run. See
[Structured and background AI](/en/docs/ai/structured-and-background-ai#reuse-durable-ai-from-an-application-job)
for the application API.

Run the existing `migrateWorkflowAi()` migration before starting workers from
the new image. It makes `ai.workflow_task.run_id` nullable and adds
`usage_subject` for authenticated personal calculations and `released_at` for
application result retention. Existing workflow rows
and their cache identities remain unchanged. No new service or environment
variable is required.

Application-owned tasks share `WORKFLOW_AI_BUDGET`,
`WORKFLOW_AI_ATTEMPT_TIMEOUT_MS` and `WORKFLOW_AI_QUEUE_TIMEOUT_MS` with workflow
inference. Capacity and rate admission remain atomic across replicas; cached
successes do not consume another admission. The shared worker recovers queued
jobs and marks expired deliveries visibly failed. Durable task requests contain
source data and results; handle them with the application's data access policy.

A personal `usageSubject` uses Assistant model grants and allowances. Tasks
without one use the central background budget and emergency stop. Both record
provider usage through Cloud's existing accounting; no second charge is added
for storing a task result.

Drain the application's own jobs before stopping the shared AI runtime. Aborting
an observer stops its wait; the shared worker retains ownership of the inference
so another observer can recover it. To recover a terminal failed request, inspect
the failure and start a new intentional request. A completed
request can be replayed with its original effect key without another charge.

## Release results after domain settlement

The application must call `releaseApplicationAiTask()` from `@k2b/cloud/ai`
when it durably settles or discards its request, including failed requests.
Pass the same application, scope, raw effect key and optional usage subject
used for `runApplicationAiTask()`. Pass the application's Postgres transaction
as the second argument so the release commits together with the domain result:

```ts
import { sql } from "bun";
import { releaseApplicationAiTask } from "@k2b/cloud/ai";

await sql.begin(async (tx) => {
  await persistRequestResult(tx, request.id, result);
  await releaseApplicationAiTask({
    appId: "inventory",
    scopeId: warehouse.id,
    effectKey: request.id,
    usageSubject: request.usageSubject,
  }, tx);
});
```

Release returns `true` when the task exists and `false` when none exists.
Repeated release preserves the first release time. It can also release active
work that the application no longer needs; it does not cancel inference or
reset admission accounting. Do not release from an observer's abort handler
while another worker still needs the result.

The existing AI recovery sweep deletes at most 100 terminal application tasks
per pass once **both release and completion are more than 24 hours old**.
This fixed window uses the existing 24-hour admission-history horizon. It is
a replay grace period after settlement, not a deadline for pending requests.
Requests, outputs, errors and usage stored in those task rows are deleted;
central usage accounting remains intact. Workflow-owned tasks keep their
existing run deletion lifecycle.

Unreleased results remain available regardless of age, so a dormant application
request can recover without another inference. Applications must reconcile
releases for already settled requests when adopting this lifecycle. After
pruning, an old effect key no longer prevents another inference: never resubmit
a settled request. Keep the application's permanent request state authoritative.

## Delete owner data

Call `deleteApplicationAiTasks({ appId, scopeId }, tx)` from `@k2b/cloud/ai`
inside the transaction deleting an owning scope. Add `sourceId` to restrict
deletion to one exact source identity, or `sourceIdPrefix` to remove a source's
snapshot history. For example, `sourceIdPrefix: itemId + ":"` removes both
`itemId + ":42"` and `itemId + ":manual:request"`. Prefixes are literal;
`%` and `_` are not wildcards. When both source filters are supplied, both must
match. Application and scope filters always apply. The function returns the deleted count
and removes application tasks in every status immediately. Workflow-owned
tasks and other scopes remain untouched. Existing rate and daily admission
history retains its normal 24-hour lifetime; deleting data does not replenish
budgets.

Owner cleanup serializes with AI task admission. Running workers observe a
removed task as canceled, and late completion cannot recreate its row. The
application must fence future task creation and recovery for deleted owners.
Call cleanup last in a short deletion transaction: its global admission lock
is held until that transaction commits, including when passed an existing transaction.
Likewise, a worker that creates a task after an earlier release found no task
must release it when it discovers that its domain request was discarded.

Applications periodically page `listUnreleasedApplicationAiTaskSources({ appId,
after? })` (up to 100 distinct scope/source identities). Under the domain owner
lock, delete sources whose owner no longer exists. This reconciles a worker
crash between late task creation and noticing owner deletion, while retaining
unreleased results for live dormant requests. Mail performs this at startup and
in its minute recovery sweep.
