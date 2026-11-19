---
title: Code runs
navTitle: Code runs
section: Platform services
order: 965
description: Start Code, understand retry and schedule outcomes, and read the recorded calls.
tags: [code, runs, schedules, runner]
updated: 2026-11-18
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

Each checked `app.on` registration subscribes to its exact declared place.
Without a handle that is the resource owning the Code; an explicit handle can
name another readable place. Personal Code uses its owner account, while
resource-owned and app-owned Code use their dedicated account. Cloud rechecks
the execution mandate, active version, declared place and current resource
read access before delivery, and repeats the place read check before every
run, retry and rerun. The event carries references;
it does not grant read or write access.

Admission commits one pinned `event` run, its event receipt and the existing
run outbox in the same transaction, before acknowledging platform delivery.
A crash after that commit can repeat delivery but cannot create a second run.
The receipt is keyed by Code and event ID, survives run-detail retention and
version switches, and is deleted with the Code. Receipts are permanent deduplication
state: deleting one while the publisher can repeat that event ID could admit it twice.
Its input is the event reference
envelope. Runs for one Code and resource place start in admission
order, across all event types, without overlapping, including different message subjects, even when the
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
(default 100), and the number of event registrations in a version. Loss of
read access is visible in event deliveries or a failed run as
`resource_access_revoked`; restore the share before retrying. When full, admission retries through the platform's existing
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

## Follow calls and console output

### Read one run and its entries

Use `core.code.run.list` for run metadata, with its existing cursor and
`limit` (default 20, maximum 50). `core.code.run.entries` takes `{ codeId,
runId }` and returns `{ state, outcome, startedAt, endedAt, output }`. Its `output` is
the same sanitized, bounded window as `core.code.run.read`'s
`contents.consoleOutput`; it loads no capability call or input payloads.
Readers receive `output: null`. Only people who manage the Code, including
administrators of its owning resource, receive entries. API, SSR and CLI
queries use the same Code authority and output reader. Missing runs, runs of
another Code and inaccessible Code return `NOT_FOUND`.

The window has no older-entry pagination: discarded entries cannot be loaded
again. Its size follows the run's pinned `core.code.payload_bytes` and the
existing live-frame budget. Show `droppedLines` visibly instead of offering
an unavailable history. The run list remains paginated independently.

For a browser, import `readCodeRunEntries` and `followCodeRun` from
`@k2b/cloud/browser/code-runs`. Supply the SSR snapshot as `initial`:

```ts
import { followCodeRun, readCodeRunEntries } from "@k2b/cloud/browser/code-runs";
import type { CodeRunEntries } from "@k2b/cloud/code";

function observeRun(codeId: string, runId: string, initial: CodeRunEntries) {
  return followCodeRun({ codeId, runId }, {
    initial,
    snapshot: async (signal) => {
      const result = await readCodeRunEntries({ codeId, runId }, signal);
      if (!result.ok) throw new Error(result.error.message);
      return result.data.data;
    },
    apply: (snapshot) => console.info(snapshot.state),
    unavailable: (reason) => console.info("Show recovery:", reason),
  });
}
// Dispose the returned stop function with the island. Replace console.info
// with the page's state and a visible retry/reload notice.
```

The `codeRun` channel on the existing `/api/ai/live` socket accepts
`{ codeId, runId }`. It admits Code managers for that exact run. Core checks
rights at admission and on access changes; the existing reauthorization
sweep covers owner rights outside Core. NATS distributes `code.output` and
payload-free `code.run` events. Cancelled runs retain `state: "cancelled"` on
both the Code-wide and selected-run channels, matching the server snapshot. Ordinary output delivery and local application
issue zero SQL. Admission, a sequence or replay gap, and the terminal state load a
covering snapshot. Reconnects replay from the existing live cursor or request
that covering snapshot when the cursor is no longer retained. There is no
per-output-event query or separate socket.
`CodeRunEntriesInputSchema`, `CodeRunEntriesSchema`, `CodeRunLiveEventSchema`
and their result/event types are exported from `@k2b/cloud/code`.
Browser-only schema consumers can also import `CodeRunEntriesInputSchema`,
`CodeRunEntriesSchema` and `CodeRunEntries` from `@k2b/cloud/contracts/code-runs`.

`RunLog` from `@k2b/ui` remains presentational. Its host owns the clock,
connection, duration, recovery and loading. Confirmed call summaries remain
visible as quiet output lines, including runs with no logged steps or messages. Gustav's **Runs** detail renders
the server snapshot first and opens output for Code managers. A stopped
connection retains the last visible snapshot with **Try again**; revoked
access removes its output and offers **Reload**.
The page supplies its request timezone through RunLog's `timeZone` prop so
server output and the first browser render show the same timestamps.

### Follow all calls of a Code

The `code` channel on `/api/ai/live` carries only run state. Readers receive
no call hints or console output. The separate `codeDetails` channel accepts
`{ codeId }` and authorizes Code editors, including administrators of the
owning resource. Being a Cloud administrator alone does not grant access to
these contents. This Code-wide channel carries call hints only; output travels solely on
the selected run’s `codeRun` channel. Revocation and credential scopes apply to all channels.

After committing a call receipt, Core publishes a `code.call` hint with
`runId`, `ordinal`, `operation` and `state`. Completion publishes another
hint after committing the result. Hints contain no inputs, results, names or
links. They cost no SQL; reload the authorized run snapshot after reconnect
or completion. The page's SSR `operationLabels` supplies `running` and `done`
strings from the operation catalog before subscribing. Values that require
actual results are resolved when the run ends.

A Code invocation gets its own `console.log`, `info`, `debug`, `warn` and
`error`. Uncaught sandbox errors include their text and stack in this output.
Core removes terminal escapes, controls and direction marks, and replaces
recognized echoes of secrets used by the attempt with `{ type: "secret",
name }` parts. Other parts are `{ type: "text", text }`. Render text parts
with text nodes, and secret parts by name; never use HTML or a terminal
interpreter. The replacement spellings match HTTP response redaction,
including supported encodings.

Cloud hides known secret values in output to protect against accidental
printing. Code that deliberately changes a secret before printing it can
still reveal it. Only authorized Code editors can view the output.

Possible secret prefixes wait in a bounded, encrypted
redaction buffer across lines and bundles. An unresolved final fragment becomes
a named secret marker; deferred fragments can be combined into one entry with the original timestamp and level.

`core.code.run.read` returns `contents.consoleOutput` on the first call page
(`cursor: 0`), or `null` on later pages. Readers still get `contents: null`.
A queued retry retains the previous attempt's frozen output until the next attempt starts.
The same permission-aware service serves API, CLI and agent calls. SSR exposes
the window as `CodePageRunDetail.consoleOutput`.

Stored snapshots and live deltas carry an `entries` array of structured records.
The discriminated records are:

```ts
type OutputText = Array<{ type: "text", text: string } | { type: "secret", name: string }>;
type LogEntry = {
  id: string, // stable within this run
  kind: "log",
  level: "log" | "info" | "debug" | "warn" | "error",
  at: string, // ISO 8601 UTC timestamp captured by the invocation's console
  text: OutputText
};
type StepEntry = {
  kind: "step"; id: string; at: string;
  label: OutputText; icon?: string; description?: OutputText;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  startedAt?: string; endedAt?: string; message?: OutputText;
};
type RunEntry = LogEntry | StepEntry;
```

`console.log` produces `kind: "log", level: "log"`; the other console methods
keep their level. `console.error` and uncaught errors with stacks use
`level: "error"`. Multiline text produces entries with the same timestamp.
The timestamp describes capture time, not trusted execution order; `generation`
and `seq` order transport deltas. Core assigns each published log entry an
`id` from its generation, delta sequence and position in that delta. The ID
survives window eviction, snapshot reads and replay; it is not an author-supplied key.

Readers retain unknown `kind` values as opaque objects in the same bounded
window and skip their rendering. Use `isCodeOutputLogEntry` and
`isCodeOutputStepEntry` from `@k2b/cloud/code` before reading known fields.
Malformed known entries are rejected. Steps use the existing JSON storage;
no migration is needed. Core derives each step ID from the attempt generation
and its run-local ordinal. A new revision replaces the same ID at its original
position in the retained window. Apply live events with `applyCodeOutputEvent`
to get the same result as stored snapshots and replay.

At the RunLog display boundary, render named secret parts as text labels and
map console `log`/`debug` to the display level `info`. Never pass raw HTML.
Step labels, descriptions and messages use the same text parts, cleaning and
continuous secret redaction as logs, including across fields and bundles.
Deferred text retains the originating field. Icons are optional identifiers;
names use at most 64 lowercase letters, digits or hyphens, without an
icon-library prefix. Unusable or redacted icons are omitted; RunLog adds its
own prefix.

### Report steps with logger

Import `logger` from the Code SDK. Declare the steps at the start of the
handler so viewers can see the planned work before it starts:

```ts
import { app, logger } from "@k2b/cloud/code";

app.schedule({ cron: "0 8 * * *", name: "report" }, async () => {
  const read = logger.step("Read document", {
    icon: "file-text", description: "Read the document and its positions."
  });
  const save = logger.step({ label: "Save positions", icon: "table-plus" });

  read.start();
  logger.info("Reading positions");
  read.succeed("Document read");

  save.skip("Already saved");
});
export default app;
```

`logger.step(label, { icon?, description? })` and
`logger.step({ label, icon?, description? })` immediately create a `pending`
entry and return a `CodeLogStep` handle. Call `start()` to make it `running`,
then `succeed(message?)`, `fail(reason)` or `skip(reason)`. You can also skip a
pending step, or fail it without starting it; neither sets `startedAt`.
Starting twice, completing an unstarted step with `succeed`, and all calls
after the first terminal result have no effect.
Each handle keeps one row; there is no separate step definition or string key.
`CodeLogger`, `CodeLogStep` and `CodeLogStepOptions` are public SDK types.

`logger.info(text)`, `logger.warn(text)` and `logger.error(text)` produce
ordinary `kind: "log"` entries with that level. Existing console methods keep
their behavior. For transient `chat` and `test` invocations, the run-local
console and logger are available but do not send production output.
These methods report output; calling `fail` or `error` does
not itself fail the run or throw an exception.

An uncaught Code exception fails every running step and sets its `message`
to the exception message, within the output limits. Its text and stack also
appear as error logs. Pending steps stay `pending` in storage: after a
successful run, RunLog displays them as skipped; after a failed run it displays
them as pending. The display owns this distinction. At attempt closure, Core
completes any remaining running step as `succeeded` when the run succeeds,
or `failed` for failure, cancellation or expiry. That automatic failure sets
`reason: "run_ended"` and an empty `message` array. The reason is separate from author-supplied completion text. Consumers
accept an optional string `reason`; the Cloud RunLog host renders its
localized explanation. A forced termination may
lose the last unflushed update, just like console output.

Steps and logs share the existing output window and loss counters.
`CODE_OUTPUT_STEP_LIMITS` derives a lifetime step count of **25** from the
canonical complete step, including string IDs, named secret parts, lifecycle
timestamps and automatic completion, and `LIVE_LIMITS.frameBytes`. Its per-field
encoded JSON byte limit divides the remaining raw bundle among label, icon, description
and message, after reserving the lease envelope. Run-local handle metadata
uses the same canonical byte reservation in Runner and Core, within the pinned
`core.code.payload_bytes` window and the available live frame. Each short
text field reserves space for a named secret marker; larger fields consume
the remaining shared budget. Redaction expansion stays within that handle
reservation. Rejected IDs stay inactive for the rest of the attempt.
Long fields are shortened. When handle storage is exhausted, `step` returns
an inert handle and counts one lost entry; the run continues. Completion
messages are shortened to the remaining handle budget. Only invalid argument
types throw (`code_output_invalid_text` or `code_output_invalid_step`).
Core accepts each step's label, icon and description once, and its message
only at the first completion. Revisions advance status and monotone timestamps;
accepted text and completed steps cannot be rewritten. Step metadata shares
the pinned output budget. Logs yield before steps when the window fills, so
retained steps keep their creation order. Output batches remain subject to
the same frame and cadence limits, so a busy run can lose updates. Buffered
revisions without new text coalesce across intervening entries, including
`running` and a completion without a message. Revisions with completion text
keep their position after intervening logs or other steps. In-flight runs
from an earlier deployment restore missing step reservations from their
accepted step fields before accepting more metadata.
Only authorized Code editors see steps, including through API, CLI and agents.

The window contains `generation`, `seq`, `entries`, `droppedLines` and
`droppedBytes`. It keeps whole recent lines within the run's pinned
`core.code.payload_bytes` budget (32 KiB by default), measured as UTF-8 JSON
of the structured entries. Fixed metadata is outside that budget. Oversized
lines, earlier lines displaced from the window, and excess batches contribute
to the loss counters. `droppedLines` is the number needed for an “N earlier
lines missing” notice. These counters describe dropped output, not execution
failure. After a gap, Cloud can discard nearby entries conservatively while
completing pending secret markers. Those additional losses also count here.

Each raw bundle, including the runner's proof envelope, fits
`LIVE_LIMITS.frameBytes`. The trusted supervisor joins submissions and waits at least the AI
stream's existing snapshot interval between bundles; Core discards excess
bundles and counts their lines and bytes. This cadence spans all attempts of
the same run. Sanitized NATS deltas obey the same frame limit. `followCodeRun`
requests a covering snapshot on admission, reconnect or a sequence gap.
Apply deltas with `applyCodeOutputEvent` from `@k2b/cloud/code`; replace the
window on a snapshot. Render only this bounded window, so the live, replayed
and stored tails agree.

Late arrivals replay the run's dedicated NATS topic. A shared cache repairs
publication gaps or topic retention with a covering snapshot. Terminal
settlement freezes output admission and stores the window once in the run
row. Retry, visitor cancellation and owner deletion close the attempt fence
too; retry retains a frozen snapshot until the next attempt starts. Output
for every retained terminal run is stored once; output batches issue zero SQL. The row and its output expire together
after 30 days. A new attempt starts a new output generation; output is not an
execution journal. Loss of the shared cache can lose the active window.
A forcibly terminated isolate can lose its last unflushed bundle.
