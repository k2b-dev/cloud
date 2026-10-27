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
`usage_subject` for authenticated personal calculations. Existing workflow rows
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
