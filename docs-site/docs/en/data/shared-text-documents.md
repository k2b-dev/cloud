---
title: Shared text documents
navTitle: Shared text documents
section: Data
order: 430
description: Let people and agents edit the same text through a retained log and application-owned snapshots.
tags: [data, text, collaboration, sync, yjs]
updated: 2026-10-19
---

# Shared text documents

Use `@k2b/cloud/shared-text` for text that people and agents write at the same
time. One retained log carries updates; a snapshot in the application's own
Postgres table holds durable state. This is a server-only API. Callers must
authorize access before calling `read` or `edit`.

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
The application owns snapshot scheduling and keeping idle document cursors
inside the log's retained window. See [Topics and live events](/en/docs/automation/topics-and-live-events).

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
returns `null` for a missing document, otherwise `{ state, text, cursor }`.
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
