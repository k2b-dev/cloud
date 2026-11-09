---
title: Code runs
navTitle: Code runs
section: Platform services
order: 965
description: Start Code, understand retry and schedule outcomes, and read the recorded calls.
tags: [code, runs, schedules, runner]
updated: 2026-11-07
---

# Code runs

A run executes one named entrypoint of an active, checked Code version. Core
pins that version when it accepts the run. Activating another version before
a queued run obtains a lease terminates that queued run with `code_not_active`;
already running attempts may drain under their original authority. The run list shows its state and
its capability calls in order. A run does not resume at a saved step.

## One-off chat jobs

Gustav's `code_run` uses the same runner pool as lasting Code. Core queues a
`chat` job; the runner loads a fresh workerd isolate with the generated SDK
and the existing script helpers. The chat keeps the same tool name, result
card, run ID, inspect/stop/export controls and ordered approval flow.
These jobs do not appear in a lasting Code's run list. Their results remain
in the chat.

The Assistant host authorizes selected chat files, capability calls, HTTP,
views and exports for the originating turn. The sandbox has no direct network
or credentials. Scheduled chat routines are retired; rebuild timed work as
reviewed personal Code. Studio RSQL database grants do not authorize a runner
database and are unavailable in `code_run`.

The following limits apply:

| Boundary | One-off chat run |
| --- | --- |
| Source and selected files | Existing script limits: 1 MiB per source file, 2 MiB total source, 64 files; selected files up to 50 MiB each and 250 MiB total |
| Submitted job | 8 MiB UTF-8 JSON, including script and bundled helper modules |
| Script bundle | `core.code.bundle_bytes`, default 4 MiB; helper modules also count toward the job limit |
| Elapsed time | `core.code.wall_clock_ms`, default and maximum 300 seconds, including queueing and approval waits; progress does not extend it |
| Memory and liveness | The runner's process-memory limit and workerd watchdog |
| Bridge messages | 256 KiB per request and response, including JSON envelopes and base64 file bytes; larger file transfers fail visibly even when within the selected-file budget |
| Calls | `core.code.calls_per_run`, default 200; script RPCs, logs, progress and terminal messages all consume this budget; exhaustion reports `code_job_call_limit` |
| Admission | The shared runner slots and `core.code.job_pending` / `core.code.concurrency_per_owner` job limits |

The existing script startup watchdog also stops an initial run that stays
silent for 15 seconds without progress or a host request, after queue admission.
The existing ceiling of 32 pending host messages bounds the isolate transport. Inspect output is
still truncated at 16,000 characters and keeps the latest 20 log entries.
Captured exports and views retain the existing 64-item and file-size budgets.

Cancellation, a lost lease, an expired deadline or a lost Assistant host ends
the attempt. A chat job and a delivered bridge request are never automatically
replayed: inspect completed effects before deliberately starting another run.
The Assistant retains live run state until its host closes; durable tool
results and exported chat files follow the chat's existing retention.

## Start or run again

Use the `core.code.run` Action at `target: { type: "core.code", id: codeId }`,
with `entrypoint`, optional JSON
`input`, and the normal capability idempotency key. It returns `runId` and
`duplicate`. Code itself cannot invoke this Action. CLI, chat, and resource
pages share the same permission-aware service. The Action presents a localized
review of the Code and entrypoint before execution; it always asks for this start.

Core's internal service `startCodeRun(request, context)` uses keys per Code;
its callers supply their own namespace. It accepts
`codeId`, `entrypoint`, `idempotencyKey`, and optional JSON `input`. The caller
needs Code editor permission and a credential that permits writes. The
entrypoint must occur in the active version's checked manifest. The active
version still needs its current policy, approval, and version mandate.

The capability key is scoped to the calling principal and Code. The same key
and request return the original `runId` and
`duplicate: true`; concurrent requests cannot create a second run. Manual receipts
remain after the 30-day run-detail retention, so a repeated old key can refer
to a run whose details are no longer available. Receipts contain only the key,
run ID, and request digest and are deleted with the Code. Reusing a key with a
different entrypoint or input returns a conflict.

“Run again” (“Erneut ausführen”) uses a new request key and the currently
active version, and passes the failed run's ID as optional `rerunOf`. Core
accepts only a failed run of the same Code and entrypoint. `core.code.run.list`
and `core.code.run.read` then return `rerunOf` and `rerunByName` on the new run:
the name follows directory visibility, is resolved on read, and is `null` when
hidden. `rerunOf` becomes `null` when the failed run reaches retention. Capability calls with an idempotency key can return their
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

Core registers checked cron `app.schedule` entrypoints with the Sync scheduler,
using each entrypoint's `timeZone`, or the Cloud instance's default
`app.timezone` when omitted. A spring-forward gap
skips the missing local minute; a repeated autumn minute runs once at its
first occurrence. One-time `{ at, timeZone }` schedules
use the existing Core recovery pass: a due instant is admitted once, normally
within five seconds, including after downtime of up to seven days. They do not
create recurring broker schedules. Runner count does not affect ticks.
The scheduler retains the latest missed tick after Core downtime. A durable
receipt for Code, entrypoint, and scheduled time prevents duplicate runs even
if several Core instances receive the same tick. Tick receipts expire after
seven days, matching broker retention. Core rejects older ticks, so deleting a
receipt cannot start an expired tick again. Manual receipts remain permanent.

For cron, if the previous tick of that entrypoint is queued or running, Core records the
new tick as `skipped` with outcome `previous_schedule_running`: “Skipped,
previous run is still running” (“Übersprungen, vorheriger Lauf läuft noch”).
A one-time occurrence instead stays pending until its predecessor ends, within
the same seven-day recovery window.
Schedule identity stays the same across version activation. Each tick binds the
current active version under the Code lock. Activation does not permit overlap
with the previous version's run of the same schedule. Removed or changed
schedules reject callbacks from obsolete definitions.

A manual start of the same schedule entrypoint also blocks an overlapping
tick. Manual starts keep their own request keys. A paused Code accepts no new
manual run; scheduled callbacks do not create runs while it is paused. If a
current schedule is refused by policy or version approval, its tick appears as
a failed run with `code_admission_refused`.

## Understand event deliveries

Each checked `app.on` registration subscribes only to the resource that owns
its Code. Cloud rechecks the execution mandate, active version, owner place and
current resource read access before delivery. The event carries references;
it does not grant read or write access.

Admission commits one pinned `event` run, its event receipt and the existing
run outbox in the same transaction, before acknowledging platform delivery.
A crash after that commit can repeat delivery but cannot create a second run.
The receipt is keyed by Code and event ID, survives run-detail retention and
version switches, and is deleted with the Code. Receipts are permanent deduplication
state: deleting one while the publisher can repeat that event ID could admit it twice.
Its input is the event reference
envelope. Runs for one event registration and resource place start in admission
order without overlapping, including different message subjects, even when the
operator raises per-Code concurrency. Different resource Codes retain their
ordinary concurrency limits.

Pause and deletion cancel subscriptions and pending deliveries, including
claimed deliveries that have not committed admission. Resume creates fresh
subscriptions; events published before resume are not replayed. Activation
replaces subscriptions in the version-switch transaction. A never-started event
run stays queued during a pause. After a version switch, it becomes visibly
failed with `code_not_active`; explicit delivery recovery can bind that same
run ID to the currently approved matching registration, after a fresh read
check. This recovery never repeats a run that has started. Revoked or expired mandates, disabled
accounts and lost read access cannot admit a new run.

`core.code.event_backlog` bounds queued and running event runs per Code
(default 100). When full, admission retries through the platform's existing
delivery queue and then becomes a visible failed delivery. Failed deliveries
stay visible for deliberate replay. After bounded admission attempts, a failed
resource delivery allows different subjects at that place to proceed. Successors
of its own subject stay held until explicit replay of the predecessor succeeds.
Mail uses a separate subject for each message, so a failed message does not
hold other messages indefinitely.
The platform event retention and retry budgets also apply; there is no second
broker or event archive.

The Code page's Runs tab and `core.code.run.list` show up to 20 unresolved
event deliveries, with the oldest failures first, in `eventDeliveries`, without payloads.
This field is optional in run-list responses; clients accept replies without it.
CLI JSON and JSONL preserve the response fields in either case. Editors of an active
Code can choose **Retry delivery**. Recoverable cancellations and never-started
event runs remain in this view across pauses and version switches for 30 days
after the event reached Core. The current version must still declare the same
event and place. The `core.code.event.redeliver` Action takes
`deliveryId` at the Code target and asks before resetting that exact failed
platform delivery, transferring it to the current registration when needed.
Retrying delivery only retries admission or recovers the same never-started
run; its permanent receipt prevents another run if admission already completed. Event entrypoints
cannot be started as arbitrary manual invocations. **Run again** is available
for a failed event run and requires its unchanged original envelope. It creates
a new run of the active version, joins the current admission queue, and can
repeat effects; inspect calls before choosing it. Ordinary run attempt retries
remain subject to the effect and deadline rules above.

For bounded historical runs and fake-only real-message previews, see
[Mail automations with Code](/en/docs/platform/mail-code-automations).

## Read runs and calls

Use `core.code.run.list` and `core.code.run.read` as described in
[Code data model](/en/docs/platform/code-data-model#read-through-core-queries).
Readers see run metadata; editors can read inputs and call results. Calls are
observations committed before invoking a capability, with the result recorded
afterward. An unfinished call in a lost attempt has state `uncertain` and result
code `code_result_unknown`: the effect may have completed. An authoritative
result arriving later replaces that marker; it does not restart the run.

Both run Queries include `firstRefusedCallOrdinal: number | null` on each run.
It records the first call, in invocation order, for which the target application
returned 403 or 404. It contains no target data. Policy and approval refusals,
app admission denials and bridge failures never set it. Older runs without a
recorded classification return `null`.

For editors, `core.code.run.read` also returns
`contents.firstRefusedCall: { ordinal, kind, capability, target } | null`.
`kind` is `query` or `action`, `capability` is its qualified ID, and `target` is
`{ type, id }` or `null` for an operation without a target. This summary comes
from the recorded call, independently of the selected call page and full-input
chunking. One Query supplies the refused call's action and coordinates without
reading another application. Each paged call also has
`refusalKind: "target_refused" | "policy" | "approval" | "app_not_allowed" | "bridge" | null`.
A `null` classification means a success, an unfinished call, or a legacy call.
Readers, including Cloud administrators without Code editor rights, still get
`contents: null`; neither run Query exposes target IDs to them.

A refusal is an observed fact, not necessarily the cause of a failed run: Code
may catch it and later fail for another reason, or succeed. A page should show
the refusal warning only for a failed run. A target's 404 does not distinguish
missing access from an object that does not exist.

Core maintainers consume the scheduling contracts from
`packages/core/src/code/index.ts`: `CodeStartRequestSchema`, `CodeStartRequest`,
`CodeStartResult`, `codeSchedulingContracts`, `CodeRunLimits`,
`CodeScheduleTick`, `CodeRunnerMetrics`,
`startCodeRun`, `processCodeScheduleTick`, and `readCodeRunnerMetrics`.
`codeRunMessages` supplies English and German UI labels; stable outcomes remain
untranslated on the transport. `CODE_RUN_OUTCOMES` covers runner results,
`lease_lost`, `retry_exhausted`, admission failures, inactive versions, and
skipped ticks. A wall-clock expiry is `wall_clock_limit`, including a retry
whose deadline expires while queued. Applications use Core capabilities rather than
importing Core source.

For runner capacity, lease recovery, and shutdown, see
[Scaling runners](/en/docs/operations/code-runner).

After a claim commits, Core checks the current owner outside dispatch locks,
then signs the runner lease. A missing owner pauses Code with “Owner not found”
(“Besitzer nicht gefunden”) and skips the claimed run without issuing a token.
Owner checks run concurrently, once per Code in a fetch batch, within one
heartbeat period and the remaining poll budget. Core renews a still-valid
lease after that check without reviving an expired generation. A failed reader
only withholds that Code's lease; healthy leases in the batch are returned.
An unavailable owner reader leaves its claim to expire. Automatic retry retains
the original deadline and consumes the next attempt in the configured budget.
This uses `checkCodeOwnerBeforeRun(code)`; its optional signal cancels the owner
transport request.
