---
title: Code policy operations
navTitle: Code policy
section: Operations
order: 1253
description: Configure Code execution budgets and inspect durable policy pause work.
tags: [operations, code, policy, settings]
updated: 2026-10-31
---

# Code policy operations

Core adds the policy tables to the existing `code` schema at startup. Include
them in the same backup as Code versions and identity data. An existing policy
is preserved on restart; an empty installation starts with the Admin preset.
See [Code policy](/en/docs/platform/code-policy) for group precedence, revision
conflicts and the policy capabilities.

## Set execution budgets

Code execution budgets are registered administrator settings for
**Administration → Code**. They use the existing settings API and have no
environment fallback. They complement the
[storage budgets](/en/docs/platform/code-data-model#storage-limits-and-retention).

| Setting | Default | Accepted range |
| --- | --- | --- |
| `core.code.wall_clock_ms` | 300,000 ms (5 minutes) | 1–300,000 |
| `core.code.calls_per_run` | 200 bridge calls | 1–1,000 |
| `core.code.calls_per_second` | 60 per Code | 1–1,000 |
| `core.code.database_bytes` | 100 MiB per Code | 1 byte–1 GiB |
| `core.code.ai_budget_usd` | USD 1 reference cost per run | 0–100; zero disables AI |
| `core.code.concurrency_per_code` | 1 active attempt | 1–100 |
| `core.code.concurrency_per_owner` | 10 active attempts | 1–1,000 |

All values except the AI budget are whole numbers. The wall-clock maximum
matches the Phase 1 runner budget. The call maximum preserves the existing run
storage boundary. Database, AI and concurrency defaults and ranges are initial
operational budgets; administrators can lower them for their installation.
An owner is the exact personal, resource or application identity, so changing
an author does not create another owner allowance.

The execution and database services consume these registered settings when
admitting work. Registering a budget does not by itself implement runner
termination, AI cost reservation, database quotas or distributed concurrency;
those checks belong to their owning execution services.

## Inspect policy pause work

A policy update commits a row in `code.policy_pause_outbox` with its revision.
Core processes bounded batches every five seconds and drains pending work on
startup. Shutdown drains the active pass. Replicas claim work through the
shared PostgreSQL outbox; no additional process variable or queue setup is
needed.

For an operator investigating delayed pauses, the outbox contains `revision`,
`cursor`, `attempts`, `next_attempt_at`, `claimed_until` and `last_error`.
Failures remain stored and logged as `core:code-policy`, with exponential
backoff capped at five minutes. Keep failed rows intact so Core can retry.
The dispatcher must check policy on each call even while visible pause work
is pending.

The policy update audit preserves changed rules and the expected pause count.
Completed batches record `core.code.policy.pauses_applied` with actual counts,
including both the job revision and the policy revision used.

A successful pause is visible through Code list/read as `state: "paused"`,
`pauseReason`, `pauseRows` and `pausePolicyRevision`. Replacing the table with a
looser preset does not resume Code automatically. Resume follows the current
activation and approval checks.

## Version approvals

Core creates the additive version submission, decision and comparison-baseline
tables during setup and installs the Code-version approval handler during
service startup. Requests fail closed while that handler is unavailable.
Deploy Core with the platform role-approval migration before submitting Code
versions. Pending versions leave the current version running.

[Code versions and approval](/en/docs/platform/code-versions) describes the
checker manifest, hash-bound decisions, sole-admin confirmation and the
pause/resume checks. Sending without a person remains blocked in Phase 1.
