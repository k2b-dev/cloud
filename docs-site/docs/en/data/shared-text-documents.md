---
title: Shared text documents
navTitle: Shared text documents
section: Data
order: 430
description: Let people and agents edit the same text through a retained log and application-owned snapshots.
tags: [data, text, collaboration, sync, yjs]
updated: 2026-10-22
---

# Shared text documents

Use `@k2b/cloud/shared-text` for text that people and agents write at the same
time. One retained log carries updates; a snapshot in the application's own
Postgres table holds durable state. This is a server-only API. Callers must
authorize access before calling `read`, `edit`, `change`, `inverse`, or `accept`.

## Declare one log per kind of document

```ts
import { sharedText } from "@k2b/cloud/shared-text";

const log = sharedText.define({
  id: "drafts.text",
  retention: { maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxBytes: 1024 ** 3 },
  deadLetterRetention: { maxBytes: 16 * 1024 * 1024 },
  maxPayloadBytes: 8_104_096,
});
```

Declare a log once per kind of document, never per entity. Document IDs become
Sync tenants. JetStream reserves `retention.maxBytes` plus
`deadLetterRetention.maxBytes` for each definition, multiplied by replicas,
even when empty. Changing these values later is a resource change: a mismatch
with the installed declaration raises `ResourceDriftError`.

Size retention for updates waiting for a covering snapshot. Once a snapshot
covers them, updates are no longer needed; retention eventually removes them.
The platform snapshot pipeline saves documents and keeps idle cursors inside
the retained window. The application queues work and schedules reconciliation. See [Topics and live events](/en/docs/automation/topics-and-live-events).

`log.id` identifies the resource. `log.topicConfig` exposes the exact readonly
Sync declaration, passed through unchanged. `log.topic()` returns a fresh
Sync handle per call. Use handles after Cloud has connected Sync at startup.

## Bind the application's store

`log.withStore<Saved, Context>({ load, save })` binds persistence without
creating a platform table. `Saved` is the application's save result; `Context`
carries application data such as version or activity attribution.

- `load(docId, { signal })` returns `null` when the document is absent, or
  `{ state, cursor, restoreRevision, text }`. `state` is a Yjs snapshot, or
  `null`; `text` is fallback content when there is no snapshot. Either may be
  null. The store must anchor legacy cursors to this log before returning.
  Without a snapshot, every `read` and `edit` builds the same Yjs state from
  `text`, so keep `text` unchanged until a save stores a snapshot.
- `restoreRevision` is an opaque token. `save` must check it against the
  current row so an edit cannot overwrite a restore performed since `load`.
- `save(docId, input, context)` receives `{ state, text, cursor,
  restoreRevision, requestedAt, actor, contributors }`. Save atomically and
  reject a cursor that is not newer than the stored one. Do not overwrite a
  newer snapshot. Return the application's result, including an overtaken or
  rejected save; `edit` passes it through as `saved`.

Bind the store once, next to the table it reads and writes:

```ts
import { sql } from "bun";

type Saved = { status: "saved" | "overtaken" | "notFound" };

const draftText = log.withStore<Saved, undefined>({
  load: async (draftId) => {
    const [row] = await sql<{ text_state: Uint8Array | null; text_cursor: string | null; restore_revision: string; body: string | null }[]>`
      SELECT text_state, text_cursor, restore_revision::text, body FROM drafts.drafts WHERE id = ${draftId}::uuid
    `;
    return row ? { state: row.text_state, cursor: row.text_cursor, restoreRevision: row.restore_revision, text: row.body } : null;
  },
  save: async (draftId, input) => {
    const seq = log.topic().cursorSequence(input.cursor);
    const result = await sql`
      UPDATE drafts.drafts
      SET text_state = ${Buffer.from(input.state)}, text_cursor = ${input.cursor}, text_seq = ${seq}, body = ${input.text}
      WHERE id = ${draftId}::uuid
        AND restore_revision = ${input.restoreRevision}::bigint
        AND (text_seq IS NULL OR text_seq < ${seq})
    `;
    if (result.count > 0) return { status: "saved" };
    const [row] = await sql`SELECT 1 FROM drafts.drafts WHERE id = ${draftId}::uuid`;
    return { status: row ? "overtaken" : "notFound" };
  },
});
```

## Read and edit current text

`draftText.read(docId, { signal? })` always reads to the end of the log. It
returns `null` for a missing document, otherwise `{ state, text, cursor, restoreRevision }`.
When no newer update exists, it returns the stored values unchanged, including
nulls. Otherwise it replays newer updates and returns an encoded snapshot and
its text. Reading does not save a snapshot.

`draftText.edit(docId, { actor, context?, signal? }, update)` loads the snapshot
and replays to the log end before calling `update`. The callback receives
`{ text, contributors, state() }`; `state()` encodes that replayed document.
Return the next text, synchronously or asynchronously. Returning the same text
publishes and saves nothing. Callback errors propagate unchanged after the
Yjs documents are destroyed. When `signal` aborts before publication,
`edit` throws its reason and publishes nothing; an aborted signal also skips
the callback. An abort after publication ends as `persistFailed`.

For changed text, `edit` applies a minimal diff against the replayed text,
publishes the update with its actor, then replays from the original snapshot
to the published cursor in a second document. It saves this second document,
including other accepted updates up to that cursor. It never saves the local
editing document directly.

| Status | Meaning |
| --- | --- |
| `notFound` | `load` returned null. |
| `unchanged` | Callback returned the current text; `text` is included. |
| `syncFailed` | Replay before editing failed; `error` is included, nothing was published. |
| `persistFailed` | Publication succeeded, but replay to `cursor` or save threw; `error` is included. |
| `edited` | Includes persisted `text`, published `cursor`, and the store's `saved` result. Inspect `saved` for an application rejection. |

```ts
const result = await draftText.edit(draftId, { actor }, ({ text }) => `${text}\n\nSummary added by the assistant.\n`);
if (result.status === "edited" && result.saved.status === "saved") {
  // The edit is in the log and in the snapshot.
}
```

Errors from `load`, the initial latest-cursor lookup, or publication propagate.
A `persistFailed` result means the update is already in the log: recover by
replaying and saving, rather than blindly publishing the edit again.

## Apply disjoint changes against a fixed head

Use `documents.change(docId, { actor, maxLength, context?, signal? }, update)`
for structural actions that must preserve identities between edited ranges.
Its callback receives the same replayed `{ text, contributors, state() }` as
`edit` and returns `SharedTextChange[]`, synchronously or asynchronously.
Each change is `{ from, to, insert }` in the original text's UTF-16 offsets.
Ranges must be non-overlapping with distinct starts; order does not matter.
The service applies them from right to left in one Yjs transaction. Unchanged
ranges keep their character identities, which a single broad replacement
would destroy.

`maxLength` is required and limits the resulting text in UTF-16 code units.
Invalid ranges, split surrogate pairs, unpaired inserted surrogates, and an
oversized result throw `RangeError` before publication. Empty or identical
changes publish and save nothing by default. An authorized structural planner can
set `recreate: true` on a nonempty range to replace its character identities even
when its text stays identical. Column moves use this to invalidate anchors in
both moved columns, including empty cells and identical separators. This is a
server change option, not a browser-supplied action permission. A reconstructed document with unresolved
Yjs dependencies returns `syncFailed` without calling the planner.

Publication uses the captured **tenant head** as `expectedAfter`, including
`null` for a document with no log event. A concurrent write to the same
document causes Sync's `ConflictError`; the speculative action is neither
published nor saved. Another tenant advancing the shared stream does not
conflict. A stored snapshot watermark may be ahead of the tenant's last event;
it is not the publication expectation.

The application authorizes the action and resolves durable target anchors
inside the callback. Never accept stale numeric offsets from a browser as a
current structural target. The service does not retry planners automatically:
on a conflict, re-read and validate the action before trying again. Other
publication errors can have an unknown outcome and must not trigger a blind
retry. `change` otherwise uses the same result, attribution, cancellation,
second replay, and store fences as `edit`; `persistFailed` still means an
accepted log write needs persistence, not another publication.

`edit` retains its existing character-merge behavior and does not require an
unchanged head. Choose `change` when the action or repair depends on the whole
captured structure remaining current through publication.

## Target a surviving character

Import `captureTextAnchor` and `resolveTextAnchor` from
`@k2b/cloud/browser/shared-text` in a browser, or `@k2b/cloud/shared-text`
on the server. `captureTextAnchor(ytext, index)` returns an encoded Yjs
relative position for an existing character. It rejects invalid offsets and
end boundaries. Transport those bytes with the application's normal encoding.

`resolveTextAnchor(ytext, bytes)` returns the current offset only while that
same character survives in that Y.Text, or `null`. A deleted character does
not resolve to its neighbour, an identical replacement, or an undo-created
replacement. Unknown identities, other shared types, and malformed encodings
also return `null`.

For a structural action, capture delimiter witnesses synchronously in the
browser and resolve them inside `change` against its replayed state. Then
validate that they still bound the intended row, column, or other structure.
These helpers check character identity, not document permissions or structural
meaning. The application still rejects stale context and unconfirmed local
anchors; never fall back to a submitted ordinal after resolution fails.

## Plan table actions and undo them safely

`captureTableAction(ytext, action, target)` captures structural character
identities synchronously in the browser. Send the resulting `TableActionIntent`
with byte arrays encoded by the application's transport. After authorization,
reconstruct the current Y.Text and call `planTableAction(ytext, intent, maxLength)`
inside `documents.change`. Planning derives the current row and column from
surviving anchors. A deleted or replaced target raises `TableActionRejectedError`;
a table expansion beyond the text budget raises `TableActionLimitError` before
allocating the expanded grid. Some omitted outer boundaries cannot be anchored;
these actions reject rather than choosing an adjacent cell.

For return focus, capture the selection with `captureTableFocus`. At the
authorized planning head, call `prepareTableActionFocus` with that witness and
the action. Apply the actual published receipt to a copy of that head, then
call the returned function to capture the resulting cell's identities. Send
those witnesses with the application response. After the live stream covers
the receipt, `resolveTableFocus` resolves them against the browser's current
document; a deleted target returns `null`. A speculative execution has different
inserted identities and cannot supply the focus witnesses.

Pass an `actionId` to `change` to receive the same ID and exact update bytes in
its log event and result receipt. The event also records the server's structural
provenance in the existing retained log. A `persistFailed` result can still
contain an accepted receipt. Do not publish again because the snapshot failed.

After authorizing the current document, call `documents.inverse(docId, {
actor, actionId, receiptCursor, restoreRevision, maxLength, context?, signal?,
validate? })` to reverse one of that actor's structural actions. `receiptCursor`
identifies its retained event. The service checks the actor, document revision,
surviving targets and publication head. An expired receipt or changed target
rejects without changing content. Redo reverses the receipt produced by Undo.
An alignment inverse also checks later retained actions on its original column.
Another actor's accepted alignment remains authoritative, even if subsequent
formatting returned the column to the same visible value. Alignment of a
different column and independent row insertion do not block the inverse.
If the required retained interval is unavailable, the inverse refuses to run.

Undo retains an inserted column when other edits depend on it, including
input (including whitespace) or alignment. Their text and alignment keep the original column target.
The receipt records this result so the browser can explain why the column
remains. If restoring a removed column would retarget rows accepted since
Undo, Redo rejects without changing the canonical document. Ordinary typing
continues to use the supplied Yjs UndoManager. Native Undo/Redo refuses to
restore input into a row or column whose identities were removed or reassigned
by a structural action; it leaves the document and history step unchanged.
It also checks the projected text grammar: surviving delimiter identities alone
do not prove that another writer's text will remain in its original cell.
The controller follows identities restored by its own native reversals, so
independent ordinary input steps remain undoable.

The browser entry point exports `createSharedTextActionHistory(doc,
undoManager, onChange?, onRetainedColumn?)`. Register an authorized inverse
request handler with `setInverseHandler(handler)`. Route toolbar buttons,
keyboard shortcuts and native history events through the controller's `undo()`
and `redo()`, and use `canUndo()` and `canRedo()` for availability.

Call `begin(actionId)` before a new structural request and apply incoming
events through `apply(bytes, actionId?, cursor?, retained?)` in log order.
A matching structural receipt requires its retained cursor. Await the returned
`applied` promise. Server actions remain separate history steps; their updates
must not enter the native typing UndoManager. An HTTP receipt alone does not
cover preceding log events. Cancel a known rejection with `cancel(error)`;
preserve uncertainty and reconcile an unknown outcome before retrying.
Dispose the controller when the editor closes.

## Admit delayed browser input before acknowledging it

Use `documents.accept(docId, { actor, update, baseCursor, restoreRevision,
originNodeId, originPeerId, maxLength?, signal? })` for browser updates when structural
history is enabled. `baseCursor` is the state the browser had observed when it
made the edit. Keep that cursor with pending bytes across reconnects; assigning
a newer replay cursor to old input would erase the check's context.

The service reconstructs current state and checks structural changes since
that base before publishing against the captured document head. Ordinary
Markdown input that changes table scaffolding receives a conservative server
classification too. Stale input crossing such a change, or a retained event
whose classification is unavailable, requires visible recovery. It returns
`accepted` with a cursor only after publication. Queue a covering snapshot
through the application's existing snapshot workflow.

Pass the application's existing UTF-16 text limit as `maxLength`. Admission
checks the final merged document before publication, including concurrent
updates which each fit alone. Notebooks supplies its 2,097,152-unit limit.

A pending deletion whose original target was recreated by a structural move
or by a later structural Undo requires recovery. Admission resolves the inverse's
exact retained source receipt; missing source provenance also requires recovery.
An old-base full-state update containing those same deleted
identities is ambiguous and also requires recovery; do not move its base cursor
forward to bypass this check. Already-confirmed deletion retries and a full-state
update based on the current head remain safe to accept.

`recoveryRequired` publishes nothing. Preserve the unconfirmed bytes and readable
local text, stop automatic resubmission, and offer recovery before reopening.
This also covers missing provenance and an incompatible restored revision.
`notFound` means the application store no longer has the document. Other
publication errors propagate; a known head conflict may be revalidated, while
an unknown publication outcome must be reconciled before another attempt.

## Respect restored document versions

Server `edit` and `change` events and snapshot repairs carry the store's
`restoreRevision`.
Replay applies them only to that revision; obsolete events still advance the
cursor without altering the restored document. `read`, `edit`, `change`, and the
snapshot pipeline supply the revision automatically. Advanced callers of
`log.replay`, `log.recover` or `applySharedTextEvent` must pass the matching
snapshot revision. Omitting it for a versioned event raises an error.

Custom browser transports must retain this metadata and start from a snapshot
with its matching revision. Browser writes must carry their originating revision,
including full-state reconnects and retries. Validate it against the joined
session and current store before publishing; retain that originating revision
in the log event to cover a restore during publication. Never assign the current
store revision to bytes from a different document. A client holding a different document version must
preserve unsent text and reopen the current version. Do not merge a replacement
snapshot into the old Y.Doc. Upgrade all log readers and browser transports
before enabling these server actions or automatic repair; older readers do not
understand this revision fence.

An authoritative socket receipt or replay-ready message must also be ordered
against store-only replacement. Notebooks validates and sends it synchronously
under a shared lock on the note row. Replacement takes the exclusive lock and
checks accepted live content through the captured log head before replacing an
empty target. Snapshot text alone cannot establish that the target is empty.
Transports and replacement writers must both follow this ordering before it
can be relied on during a rollout.

## Connect a browser editor

Import `createSharedTextProvider` and its `SharedTextProviderOptions`,
`SharedTextProviderTransport`, and `SharedTextProvider` types from
`@k2b/cloud/browser/shared-text`. The provider connects one Y.Doc and awareness
instance to an application-owned WebSocket transport. Use the `codemirror`
Y.Text root and retain the same document and awareness instances on reconnect.

Pass `doc`, `awareness`, `docId`, `transport`, `maxSyncPayloadLength`,
`terminalErrorCodes`, and `reconnectDelayMs`. The payload limit is the
transport's existing base64 string limit. The pending queue uses twice that
budget; exceeding it stops publication and preserves recovery input.
A populated document or `initialCursor` also requires `initialGeneration`,
the opaque token belonging to that snapshot, including historical deletes.

The transport supplies an absolute WebSocket `url`, `encode(request)`,
`decode(packet)`, and `closeError(code, reason)`. Encoding maps normalized
`replayRequest`, `syncPublish`, `awarenessPublish`, and optional event-stream
`subscribe` requests to the application's protocol. Decoding validates unknown
JSON and maps it to `SharedTextProviderMessage`, or returns null to ignore it.
Validate document IDs and preserve generation metadata on sync, awareness,
and presence packets. The provider rejects unversioned updates by default.
`allowUnversionedUpdates` preserves existing Notebook packets only; new
transports must version every update.
Only label a push `snapshot: true` when its bytes come from the durable store.

Call `connect()` after creating the provider. Replay completes before pending
input and local awareness are sent. `onReady` runs at that boundary;
`onConnectionChange` reports the socket connection. `onError` reports errors,
and `onFatal` means the session has stopped. A generation mismatch retains
recovery input and requires a fresh editor; `resume()` cannot revive it.
`isEarlierGeneration` is only for ordered revisions whose retired events
must advance the replay cursor without applying their bytes.

The returned handle provides `reconnectNow()` for dropped connections,
`resume()` for recoverable terminal sessions, `hasUnsentChanges()`,
`recoveryInput()`, and `generation()`. With an `undoManager`, route editor
history through `undo`, `redo`, `canUndo`, and `canRedo`; use `canStructure`,
`beginAction`, and `setInverseHandler` for server action receipts. Optional
`events` callbacks process application invalidations in order and advance
their independent cursor only after `onEvent` completes. Call `dispose()` on
close; the application still owns destruction of the document and awareness.

### Retain local input until a durable snapshot covers it

Use `onLocalUpdate(pending)` to persist `SharedTextProviderPendingState` before
publication. It includes document ID, generation, full binary state, readable
text, original pending payloads and their base cursors. `pendingState()` exports
the same shape for recovery. Hydrate it with `initialPending` before connecting;
its document and generation must match the authorized initial snapshot.
Hydration preserves original bases and waits for replay before resending.
Keep incompatible stored input available for recovery outside the new editor.

`onUnsentChange` and `hasUnsentChanges()` describe transport acknowledgements.
An echo does not prove that a database snapshot covers local input. Do not
delete durable local storage on echo or overwrite its original base with a
newer replay cursor. `onSnapshot({ docId, generation, state, cursor })` reports
only validated server snapshot bytes, excluding unsnapshotted local edits.
Compare those bytes with stored input before clearing covered storage. The
provider does not read or delete IndexedDB records. Storage callbacks own
visible error reporting and recovery if persistence fails.

## Snapshots

Use `sharedText.snapshots({ log, job, store, input?, logger?, repair? })` to persist
accepted updates without rebuilding a snapshot worker for each application.
It uses the same Yjs reconstruction as `read` and `edit`, including fallback
text for documents without a binary snapshot.

Declare one job per definition with `sharedTextSnapshotJobConfig`:

```ts
import { lazySync } from "@k2b/cloud";
import {
  type SharedTextSnapshotStore,
  sharedText,
  sharedTextSnapshotJobConfig,
} from "@k2b/cloud/shared-text";

const snapshotConfig = sharedTextSnapshotJobConfig({
  id: "drafts.text.snapshots",
  // Jobs carry a document ID and a cursor; a small budget is enough.
  retention: { maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxBytes: 64 * 1024 * 1024 },
});

const draftSnapshots = (store: SharedTextSnapshotStore) => sharedText.snapshots({
  log,
  job: lazySync((sync) => sync.job(snapshotConfig)),
  store,
});
```

Pass the application's snapshot store to `draftSnapshots` once. Start the
returned pipeline in the application's lifecycle and await `stop()` on
shutdown. Stop drains active work for up to 120 seconds.

The job contract is fixed:

| Setting | Contract |
| --- | --- |
| Ordering | 8 partitions, keyed by document ID; one writer per document across replicas. |
| Process concurrency | One document at a time per process. |
| Acknowledgment wait | 120 seconds, with a heartbeat every 15 seconds during reconstruction. |
| Delivery | 20 attempts, with 5 seconds between attempts. |
| Terminal retention | 30 days by default; override with `terminalRetentionMs`. |
| Dead-letter bytes | 34,603,008 by default: 256 entries at the 128 KiB payload limit plus 4 KiB headroom. Override with `deadLetterRetention`. |
| Dedupe window | `dedupeWindowMs` is included only when supplied. Coalesced submits do not use it. |

Changing the partition count or other provisioned job values later is a
resource change. A mismatch raises `ResourceDriftError`; use a deliberate
resource migration. Keep an installed dedupe window even for coalesced jobs.

### Repair before saving

Pass `repair: { maxLength, plan }` when the application needs to restore a
text structure before taking a snapshot. `plan(text)` returns disjoint
`{ from, to, insert }` changes in the original text's UTF-16 coordinates.
Repair may only insert: every `from` must equal `to`. Invalid ranges,
split Unicode characters and results exceeding `maxLength` reject the job
before publication.

The ordered writer publishes repair against the captured document head,
then saves its state and cursor. If another writer advances that head,
the job retries from the current snapshot and recomputes its plan. Repair
has no human actor; replayed contributors remain credited. An already
saved document can still be repaired when explicitly queued. A no-op plan
creates no update. Documents with pending Yjs dependencies retain those
bytes in the snapshot and skip repair until the dependencies arrive.

Keep the planner idempotent and specific to structures it recognizes.
For Markdown, `repairTables` from `@k2b/ui/text-editor/model` pads recognized
ragged GFM tables without removing cell text. Pass the same text limit as its
second argument; padding that would exceed it is left unresolved without
allocating the expanded grid. It leaves code, quotes and
unrecognized damage unchanged. The application must still show unresolved
damage and verify that its rendered output contains all visible text.

### Implement the snapshot store

The application owns durable rows and all derived projections. Implement
`SharedTextSnapshotStore` with these guarantees:

| Method | Required behavior |
| --- | --- |
| `list({ limit, after?, signal? })` | Return `{ docId, cursor }` in stable keyset order by `docId`. Include only documents that take snapshots. `cursor` may be null. |
| `load(docId, { signal })` | Return `{ state, text, cursor, restoreRevision }` or null, with the same contract as `withStore.load`. Anchor legacy cursors to this log before returning. |
| `save(docId, input)` | Atomically require an unchanged `restoreRevision` and a cursor newer than the stored cursor. Apply projections such as text, search, indexes, versions and events **only when the write was accepted, never when overtaken**. |
| `recover(docId, cause, { signal })` | Keep every valid retained update, including pending structs and deletes. Save at a captured head and mark history incomplete. Never claim lost bytes were restored. |
| `advance(docId, { from, to, latest })` | Move an idle cursor to `to` only while `from` is still stored and no newer event exists. Return whether it moved. |

`save` receives `SharedTextSaveInput`, including binary state, text, cursor,
restore revision, request time, `actor: null`, and contributors. It returns
normally when saved, when the current snapshot already covers the cursor,
or when the document is gone or locked. If a restore changed the base and
the current snapshot does not cover the cursor, it must throw. The job then
retries from the current state instead of dropping an accepted update.

For recovery, `log.recover({ docId, after, until, doc, signal? })` merges valid
updates into the supplied Y.Doc and returns
`{ recoveredUpdates, malformedUpdates, historyGaps }`. It skips malformed
events and missing ranges with strict forward progress, never beyond the
fixed `until` cursor. Encoding that document preserves unresolved Yjs structs
and deletes. The application still saves the result, marks history incomplete,
and preserves any protected original required by its domain.

### Queue and reconcile work

Call `queue({ docId, targetCursor, reason })`, for example while an editor has
unsaved changes and when it closes. `reason` is a string. Jobs coalesce by
`docId:sequence`; a final unload at a newer cursor does not coalesce with a
snapshot that is already settling. The default job payload is the queue
request. An optional `input: { encode, decode }` maps it to an application's
existing payload, allowing rolling deployments to share the same job.

Each job loads the snapshot, reads the shared head **before** the document's
latest event, then replays to that event. It saves at the greater of that head
and event cursor. A later job skips state already covered by the snapshot.
Transient failures retry. A retention gap or malformed event calls `recover`,
then dead-letters the job once after successful recovery. Missing bytes stay
missing; recovery preserves the valid retained updates and pending dependencies.

The application schedules `reconcile({ signal?, heartbeat? })`, for example
hourly, and forwards the scheduler's cancellation signal and heartbeat.
Reconcile scans pages of 5,000 documents and heartbeats before each group of
200, starting with the first document. It queues a snapshot for every
document whose latest event is newer than its stored cursor, or that has
events but no stored cursor yet. It moves idle cursors in the older half of
the retained window to the captured head. It returns exactly `{ checked, queued, advanced }`.
`log.firstSequence()` reads the first retained sequence for this exact log,
or returns zero when the log is absent.

### Observe snapshot backlog

Each completed reconcile logs `Shared text snapshot backlog` at info level.
`backlog()` returns that process's last report, or null before its first
completed reconcile. Cancellation leaves the previous report intact.
Pass `logger` to use an application log source; the default source is
`shared-text-snapshots`.

| Field | Meaning |
| --- | --- |
| `log` | Definition ID. |
| `measuredAt` | Measurement time as a Date. |
| `documents` | Number of scanned documents whose latest event is newer than their snapshot. |
| `oldest` | Null with no backlog; otherwise the queued document with the oldest unsnapshotted update, by stream sequence. |
| `oldest.docId` | That document's ID. |
| `oldest.sequence` | Its first unsnapshotted event's sequence. |
| `oldest.ageMs` | Time since that event's publication. |
| `oldest.sequenceDistance` | Last scanned shared head sequence minus the event sequence. |
| `oldest.partial` | True when the lookup budget leaves a possible older update; omitted otherwise. |

The scan reuses its existing broker lookups. After scanning, it makes at most
16 short tenant replays, lowest stored sequences first. Each stops after its
first event, and reconcile heartbeats before each further lookup. Lookups
stop once no remaining document can hold an older update.
If the budget runs out first, `oldest.partial` is true.

If a lookup fails, reconciliation still succeeds and warns. Further lookups
stop. The report uses the failing document's `storedSequence + 1` as
`sequence`, null for `ageMs`, and
`lastHeadSequence - storedSequence` as `sequenceDistance`. It also includes
`historyGap`, true only for a `RetentionGapError`. An unknown age signals an
unreadable history, not an empty backlog.

## Attribute people and agents

`actor` is `{ kind: "user" | "service_account", id }`, or null for an
unattributed server edit. Published events retain `{ kind: "sync", payload,
originNodeId, originPeerId: null }` and include `actor` when supplied. Events
retained from older deployments without an actor remain readable.

Contributors are keyed by kind and ID. Replay credits the last event's
`publishedAt`. Before saving an edit, its actor replaces any earlier entry
with `lastContributedAt: new Date(requestedAt)`. Applications own how these
contributors become versions or activity records.

## Replay and validate updates

`log.replay({ docId, after, until, doc, signal? })` applies events in
`(after, until]` and returns contributors. A null `after` starts at
`topic.cursorAt(0)`. It returns an empty list when `after >= until`, and throws
if replay does not reach `until`.

`SHARED_TEXT_NAME` is `"codemirror"`, the document's Y.Text name.
`sharedTextNodeId` is generated once per process for server-origin updates.
`applySharedTextEvent` ignores awareness events and fully decodes an update
before applying it with origin `replay:<cursor>`. Malformed updates raise
`MalformedSharedTextEventError` with `docId` and `cursor`.

`isValidSharedTextUpdate`, `toBase64`, and strict `fromBase64` support ingress
and transport. `parseStreamCursor`, `compareStreamCursor`, and
`maxStreamCursor` validate and compare resource-bound cursors; cursors from
different logs cannot be compared.

## Cursor presence

Keep transient cursor presence off the retained document log. For a transport
using the Yjs awareness wire format, `createTrustedTextAwareness` from
`@k2b/cloud/shared-text` owns one authorized connection's identity and clock.
Pass `{ clientId, textName, user: { userId, name, color } }` from the server.
`textName` names the shared text root used by this editor. Allocate a
unique `clientId` for each connection across all application instances, in
the safe-integer range starting at `2 ** 32`, separate from Yjs document IDs.
An existing Sync topic can reserve an ID with an empty awareness publication
(`AA==`): add `2 ** 32` to its returned `streamSequence`. Keep that topic's
sequence across process and broker restarts.

Authorize document access before each `publish(bytes)` call and apply the
transport's existing payload limits. The method accepts exactly one local
state with an optional relative-position `cursor: { anchor, head }` or null.
Both positions must name `textName`, with a null or absent `type`; item IDs,
null items, and association values retain their Yjs meaning. It returns an
awareness update with the server identity, connection ID, and `writerId` copied
from the connection's bound input ID. Use `writerId` only to associate document
clock changes with cursor activity; it grants no identity or access authority.
Relative cursor positions retain their document IDs. Consumers resolve positions
only against the editor's existing text root. Invalid input throws
`InvalidSharedTextAwarenessError`. Call `remove()` on leave or disconnect and
publish its returned bytes when non-null.

The browser publishes only its local awareness state, including on reconnect.
Return the connection's peer ID in the replay-ready response and include it
as the origin of cursor updates, so the browser can skip its own rewritten
echo. Remote timeout removals stay local. A new connection receives a fresh
server ID; the standard awareness timeout also clears abandoned cursors.

### Preserve the awareness topic across restarts

Operators must preserve the awareness topic and its JetStream sequence state
across application and broker restarts. Restore that broker state when moving
the installation. Ordinary WebSocket reconnects reuse browser document and
awareness lifetimes.

If administrative deletion and recreation is necessary:

1. Stop all application producers and keep document connections unavailable.
2. Retire every existing editor document and awareness instance, including
   suspended tabs and other clients that could reconnect later. Require fresh
   editor instances before those clients can connect again. A WebSocket-only
   reconnect or waiting for cursor expiry does not complete this step.
3. Recreate the topic, then restart producers and admit only fresh client
   document and awareness instances.

Do not recreate the topic while clients from its previous lifetime can return.
If that client retirement cannot be enforced, preserve the existing broker
state and postpone recreation. This transport does not provide a topic-epoch
handshake that retires existing clients automatically.

## Keep unconfirmed input on the device

`openAuthorizedSharedTextOffline(identity, authorize, signal?)` from
`@k2b/cloud/browser/shared-text` opens IndexedDB for one
`{ userId, draftId, generation }`. It captures the user's local logout epoch
before calling `authorize`. That callback must freshly authenticate the
person, authorize this document and verify its generation on the server.
The helper returns `{ session, authorization, state }` only after checking
that the epoch still matches. Do not display stored draft bytes before this
check succeeds. Bind each browser request, including reconnects, to the
account whose offline namespace the page opened.

Use `listSharedTextOfflineGenerations({ userId, draftId })` to discover pending
older generations. It reads only IndexedDB keys, never draft bytes. Select the
appropriate generation and authorize before loading it. A localStorage marker
is not an authoritative index: its update cannot be atomic with the bytes.

`session.save(fullState, baseCursor)` transactionally merges complete Yjs state
from concurrent tabs and retains the earliest original input cursor. Save
deletions as well as insertions. `loadPending()` reads bytes and their cursor
atomically; the authorization helper also returns this `baseCursor`. Never
substitute a newly read server head for the base of older offline input. An
unknown base remains null and requires conservative history validation. `session.acknowledgeSnapshot({ identity, state, durability:
"durable" })` removes stored input only when the supplied snapshot covers
all its structs and deletions. The application must establish that these
exact bytes were committed to its durable store; a socket echo or completed
replay does not establish durability.

Observe `session.signal` and expose storage failures with retry and a way to
copy pending text. Call `close()` on disposal. `forget()` explicitly removes
this document's record. A memory-only choice bypasses IndexedDB; explain that
closing the tab then loses input which has not reached the server.

`logoutSharedTextOffline(userId)` advances the user's epoch and erases their
records in one transaction. It also notifies other tabs. The transaction
check fences stale writers even if a tab misses that notification. Custom
sign-out controls use `signOutBrowserSession(userId, errorMessage)` from
`@k2b/cloud/browser/session`: it fences storage before and after revoking the
server credential. It binds logout to the rendered account; a changed account
requires reopening the page before retrying. Keep a visible retry if either
step fails. App-owned localStorage entries use `cloud:user:<userId>:`. Logout
removes this namespace and changes `cloud:user-epoch:<userId>`; capture that
token when opening authenticated storage and check it before every read/write.
The same page receives `cloud:user-storage-invalidated` with `{ userId }`;
other tabs receive the native storage event. Keep the epoch tombstone, and do
not claim or delete legacy entries whose user is unknown.

## Exchange anchored table actions

The browser entry point exports `TextTableActionRequestSchema`,
`TextTableActionResponseSchema`, `EncodedTableActionIntentSchema`,
`encodeTableFocus`, `decodeTableFocus` and `decodeTableActionIntent`.
These share the canonical character-anchor encoding between applications.
An application may replace the request's `restoreRevision` field with its
own generation field. It still owns permission checks, lifecycle checks,
publication outcomes and persistence errors.

## Freeze the exact send boundary

`documents.freeze(docId, { actor, restoreRevision, signal?, validate })`
replays to the captured log head, rejects unresolved Yjs dependencies,
validates a copy of the full state and publishes a generation-scoped freeze
marker with a compare-and-set against that head. It returns the exact
`{ state, text, cursor, restoreRevision }`, or null for a missing document.
It does not change the application's lifecycle or save its snapshot.

The application must serialize admission and sending through the same
persistent document lock. In the send transaction, store the marker,
complete document, attachment revision and send intent atomically. Only a
committed reference closes that generation. A marker left by a rolled-back
transaction is inert during replay; it must not prevent subsequent edits.
Preserve a device's differing full content as a separate recovery draft,
including deletions. A state-vector delta alone cannot represent that copy.
If the device has the same visible content but newer item or deletion identities,
commit a receipt for its exact source state before acknowledging device cleanup.
The older send snapshot alone does not cover that state.

This boundary does not change the topic's retention policy. Do not activate
an application that promises retention until snapshot coverage while its
installed Sync topic can still expire or evict uncovered updates.
