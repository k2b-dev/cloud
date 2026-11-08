---
title: Code policy operations
navTitle: Code policy
section: Operations
order: 1253
description: Configure Code execution budgets and inspect durable policy pause work.
tags: [operations, code, policy, settings]
updated: 2026-11-08
---

# Code policy operations

Hosted routes now pass the signed-in visitor's account profile (`user` or
`guest`), identity provider ID (`local` or `ipa`) and display name alongside
their ID and groups. Deploy Core and the Code runner from the same Cloud
version so request validation and generated SDKs agree. Public routes keep
receiving `null`; see [Serve routes](/en/docs/platform/code-sdk#serve-routes).

Core adds the policy tables to the existing `code` schema at startup. Include
them in the same backup as Code versions and identity data. An existing policy
is preserved on restart; an empty installation starts with the Admin preset.
See [Code policy](/en/docs/platform/code-policy) for group precedence, revision
conflicts and the policy capabilities.

Mailbox-owned Code requires Mail's canonical `mailbox.read` response to include
`data.view.title` and `data.view.permission`. Deploy the Mail update with Core
before enabling this workflow. The shared Code page and attention indicator read
the standard Core capability response envelope. No database migration or new
setting is needed.

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
| `core.code.ai_budget_usd` | USD 1 reference cost per generate/decide attempt | 0–100; zero disables generate/decide |
| `core.code.ai_daily_budget_usd` | USD 1 reference cost per Code per day | 0–100; zero disables AI |
| `core.code.ai_owner_daily_budget_usd` | USD 1 reference cost per owner per day | 0–100; zero disables AI |
| `core.code.concurrency_per_code` | 1 active attempt | 1–100 |
| `core.code.concurrency_per_owner` | 10 active attempts | 1–1,000 |

All values except the AI budgets are whole numbers. The wall-clock maximum
matches the Phase 1 runner budget. The call maximum preserves the existing run
storage boundary. AI and concurrency defaults and ranges are initial
operational budgets; administrators can lower them for their installation.
An owner is the exact personal, resource or application identity, so changing
an author does not create another owner allowance.
Code-started chat turns also consume the daily per-Code and per-owner budgets;
they do not use the generate/decide per-attempt limit. All three settings are
installation-wide. Zero disables the corresponding AI path.

Code enforces the per-attempt AI reference budget on `core.ai.generate` and `core.ai.decide` calls,
alongside the effective group policy for **AI**. Zero refuses before model
invocation with `code_ai_budget_limit`. The run detail names the exhausted AI
budget in its notice instead of the general policy message. Each admitted call reserves the smallest remaining allowance across the attempt,
Code day and owner day atomically; parallel calls cannot spend it again.
Within an attempt, another AI call is refused with `code_ai_budget_reserved`; wait for the first call before retrying. With the default limits, the full-remainder reservation also allows only one AI call at a time across an owner's Code: concurrent attempts receive a daily-limit refusal until it settles. Calls are not queued. After the
call, Core accounts the returned model's reference prices and input/output usage,
and releases the unused reservation. Measured cost can exceed the remainder of
an already started call; further AI calls are refused once the budget is reached.
Only one call can be in flight; decision input and output are bounded by the
selected model's context window. This setting controls admission, rather than
truncating an admitted model response.
Known refusals before model execution release the reservation; unknown outcomes
keep it spent, including an interrupted attempt whose call cannot be settled.
Models without reference prices do not add cost, like explicitly free models.
Successful catalog/history reads add no model cost. Zero still blocks all
`core.ai.*` calls from Code. A new attempt starts its own attempt budget; the daily aggregates remain spent,
including across automatic retries, new versions and manual reruns. Text and
structured generation (`core.ai.generate`) use the same reservation path as
`core.ai.decide`. Generation accounts measured or estimated usage from every provider attempt, including failed structured-output repairs. A quota refusal before any provider attempt costs zero. Missing usage keeps the reservation spent; a terminal failure alone does not prove zero usage.

Days follow the installation's `app.timezone` (UTC when unset). Settlement
always uses the admission day, including when a call finishes after midnight.
The owner aggregate covers all Code of the exact person, resource or
application; another author or a recreated Code does not reset that owner's
budget. Deleting run history does not release daily spend. Daily counters are
kept for the same 30-day history window as finished Code runs and belong in the
Core database backup.

`code_ai_daily_budget_limit` means the Code's daily allowance is spent or
reserved; `code_ai_owner_daily_budget_limit` means the same for its owner.
The run detail names the limit in DE/EN. Wait for running calls to settle or
the next installation calendar day, or review the configured limit. Do not
rerun repeatedly: a new attempt cannot reset these counters. As with the
existing attempt budget, this is reference-cost admission, not a hard provider
billing cap: measured cost of already admitted inference can exceed its
reservation. Unpriced models add no reference cost.
Person/service-account AI allowance still applies.
Gustav chat and direct `cld` capability calls do not use the Code run budget.

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
