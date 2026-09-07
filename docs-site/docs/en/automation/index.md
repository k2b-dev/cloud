---
title: Automation
navTitle: Overview
section: Automation
order: 600
description: Choose the smallest execution model that preserves the work and recovery guarantees you need.
tags: [automation, jobs, workflows]
updated: 2026-09-07
---

# Automation

Choose the smallest runtime that preserves the work you cannot lose.

The important decision is not whether work runs "in the background." Decide
where its state lives, what a crash may repeat or discard, and whether a person
must be able to inspect and resolve it later. More durability adds leases,
idempotency, retention, and operational state that simple work does not need.

## Choose an execution model

| Need | State and failure contract | Use |
| --- | --- | --- |
| Start and stop a local loop | Process-local; a restart discards current work | [Lifecycle work](/en/docs/automation/lifecycle-background-work) |
| Retry one local operation | Process-local; the caller owns retry safety | [Retry](/en/docs/automation/jobs-and-queues#retry-an-operation) |
| Run one durable task | NATS-backed and at least once; the handler must be idempotent | [Jobs](/en/docs/automation/jobs-and-queues#run-a-job) |
| Control receive, leases, and dead letters | NATS-backed and at least once; the app settles each delivery | [Queues](/en/docs/automation/jobs-and-queues#use-a-queue) |
| Run recurring work | Durable schedule state; occurrences may repeat during handover | [Schedulers](/en/docs/automation/schedulers) |
| Replay events or update connected clients | Retained consumer stream or best-effort live fan-out | [Topics and live events](/en/docs/automation/topics-and-live-events) |
| Coordinate app instances briefly | Expiring NATS state, never the domain source of truth | [Coordination primitives](/en/docs/automation/coordination-primitives) |
| Explain and recover a user-authored process | Immutable plan, durable run, outcomes, and effect journal | [Workflow overview](/en/docs/automation/workflow-overview) |

Lifecycle callbacks belong to the Cloud application contract.

Jobs, queues, schedules, topics, mutexes, and ephemeral state come from
`@k2b/sync` and use NATS JetStream. Local retries use `@k2b/sync/retry`. Cloud
rate limits remain on Valkey and are exported from
`@valentinkolb/cloud/server`. These primitives do not use the Cloud workflow
tables.

The workflow kernel comes from `@valentinkolb/cloud/workflows`. It owns
versioned plans, runs, leases, outcomes, effects, and operator visibility.

Do not combine several primitives merely to imitate a workflow journal, and do
not use the workflow kernel for a single bounded job. The task page owns the
complete reliability rules for its runtime. Use
[Workflow observability and testing](/en/docs/automation/workflow-observability-and-testing)
for workflow diagnostics, or the shared [Observability](/en/docs/operations/observability)
guide for application processes.
