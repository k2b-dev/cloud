---
title: Code runs
navTitle: Code runs
section: Platform services
order: 965
description: Start Code, understand retry and schedule outcomes, and read the recorded calls.
tags: [code, runs, schedules, runner]
updated: 2026-11-01
---

# Code runs

A run executes one named entrypoint of an active, checked Code version. Core
pins that version when it accepts the run. The run list shows its state and
its capability calls in order. A run does not resume at a saved step.

## Start or run again

Core's permission-aware service `startCodeRun(request, context)` accepts
`codeId`, `entrypoint`, `idempotencyKey`, and optional JSON `input`. The caller
needs Code editor permission and a credential that permits writes. The
entrypoint must occur in the active version's checked manifest. The active
version still needs its current policy, approval, and version mandate.

The same key for the same Code returns the original `runId` and
`duplicate: true`; concurrent requests cannot create a second run. Receipts
remain after the 30-day run-detail retention, so a repeated old key can refer
to a run whose details are no longer available. Receipts contain only the key
and run ID and are deleted with the Code.

“Run again” (“Erneut ausführen”) uses a new request key and the currently
active version. Capability calls with an idempotency key can return their
previous result within that capability's supported deduplication period.
Calls declaring `idempotency: "none"` execute again. Review the recorded calls
before retrying a run that may have changed data.

## Understand automatic retries

Core may restart execution automatically only before the first Action. A
reserved Action whose result is unknown counts as a possible effect. The same
conservative boundary applies to internet calls. After that boundary, a failure
is terminal: it shows “Failed” and offers the explicit rerun path.

Before that boundary, a failed or lost lease returns the run to the queue with
a new generation. This restarts the entrypoint from its beginning; it does not
replay a journal. Read-only calls from earlier generations remain in the call
list. The default limit is three automatic generations. The original
wall-clock deadline and call count remain in force throughout, including time
spent waiting for another lease; retries never refill either budget.

A failed result after a possible Action is never hidden by an automatic
retry. A late runner cannot renew an expired lease, complete a newer
generation, fetch its bundle, or invoke the bridge with its old generation.
The lease routes return HTTP 409 with `runner_lease_lost`.

## Understand schedule ticks

Core registers each checked `app.schedule` entrypoint with the Sync scheduler,
using the installation's `app.timezone`. Runner count does not affect ticks.
The scheduler retains the latest missed tick after Core downtime. A durable
receipt for Code, entrypoint, and scheduled time prevents duplicate runs even
if several Core instances receive the same tick.

If the previous tick of that entrypoint is queued or running, Core records the
new tick as `skipped` with outcome `previous_schedule_running`: “Skipped,
previous run is still running” (“Übersprungen, vorheriger Lauf läuft noch”).
Activation of a newer version does not permit overlap with the previous
version's run of the same schedule. A stale version's callback cannot start work.

Manual starts are separate from schedule ticks. A paused Code accepts no new
manual run; scheduled callbacks do not create runs while it is paused.

## Read runs and calls

Use `core.code.run.list` and `core.code.run.read` as described in
[Code data model](/en/docs/platform/code-data-model#read-through-core-queries).
Readers see run metadata; editors can read inputs and call results. Calls are
observations committed before invoking a capability, with the result recorded
afterward. A lost attempt leaves a visible failure for an unfinished call.

Core maintainers consume the scheduling contracts from
`packages/core/src/code/index.ts`: `CodeStartRequestSchema`, `CodeStartRequest`,
`CodeStartResult`, `CodeRunLimits`, `CodeScheduleTick`, `CodeRunnerMetrics`,
`startCodeRun`, `processCodeScheduleTick`, and `readCodeRunnerMetrics`.
`codeRunMessages` supplies English and German UI labels; stable outcomes remain
untranslated on the transport. Applications use Core capabilities rather than
importing Core source.

For runner capacity, lease recovery, and shutdown, see
[Scaling runners](/en/docs/operations/code-runner).
