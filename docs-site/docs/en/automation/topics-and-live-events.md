---
title: Topics and live events
navTitle: Topics and live events
section: Automation
order: 640
description: Publish retained events to consumers in application processes, and choose the right path for open tabs.
tags: [topics, events, realtime]
updated: 2026-10-04
---

# Topics and live events

Use a Sync topic for retained events that processes consume, replay, or
resume from a cursor. Cloud owns the NATS connection; declare topics through
`lazySync()`.

Choose by who reads the event:

| Reader | Use |
| --- | --- |
| The application's own open tabs, after a committed change | [Live updates](/en/docs/automation/live-updates): written in the transaction, served over the application's live socket, access checked at delivery |
| Workers of this or another application, with retries and dead letters | A topic with a durable consumer (`process()`) |
| A process that replays or follows history from a cursor | A topic with `replay()`, `follow()`, or `hub()` |
| Presence, typing, or focus that may be lost | `sync.ephemeral`, not a topic |

## Publish an event

```ts
import { lazySync } from "@k2b/cloud";

const inventoryEvents = lazySync((sync) => sync.topic<{ itemId: string }>({
  id: "inventory.events",
  retention: { maxAgeMs: 7 * 24 * 60 * 60_000, maxBytes: 64 * 1024 * 1024 },
}));

const published = await inventoryEvents().publish({
  data: { itemId },
  idempotencyKey: `item:${itemId}:${version}`,
});
```

The receipt includes `eventId`, an opaque `cursor`, and `streamSequence`.
Idempotency keys deduplicate within `dedupeWindowMs`, two minutes by default.
Choose both retention age and byte capacity: reaching either limit can remove
old events. Payload size includes the JSON envelope and defaults to 128 KiB.

Resources opened by different applications need the same explicit `owner` and
identical retention and delivery settings. A conflicting declaration fails
with `ResourceDriftError`; it does not update the existing resource, except
for the dead-letter byte limit described below.

## Keep one topic per kind of log

Use one topic for a kind of log and pass the entity ID as `tenantId`. Do not
create one topic per document, record, or mailbox. JetStream reserves each
stream's `maxBytes`, times its replicas, against the account even while the
stream is empty. Every topic owns an event stream and a dead-letter stream, so
a topic per entity multiplies that reservation by the number of entities.
Reads filter the tenant on the server, so a shared topic costs a tenant read no
more than a dedicated one.

```ts
const documentLog = lazySync((sync) => sync.topic<DocumentUpdate>({
  id: "documents.log",
  retention: { maxAgeMs: 7 * 24 * 60 * 60_000, maxBytes: 1024 ** 3 },
  // No consumer processes this log; keep its dead-letter stream small.
  deadLetterRetention: { maxBytes: 16 * 1024 * 1024 },
}));

await documentLog().publish({ tenantId: documentId, data: update });
```

Size `retention.maxBytes` from the load that must stay retained, not from
the number of entities. For example, use the peak write rate multiplied by the
longest time an event may wait for the durable state that covers it.
`deadLetterRetention` defaults to `retention`. Set it lower when the topic's
consumers rarely fail. It must hold at least one dead letter, the payload limit
plus 4 KiB. Cloud applies a changed dead-letter byte limit to the existing
dead-letter stream before the topic's first use in a process. If the stream
holds more than the new limit, it keeps its old limit, and the topic reports
`ResourceDriftError` until the stream holds less: every use fails, and an
application that uses the topic in its `setup` or `start` lifecycle does not
start. On a topic whose consumers leave dead letters, lower the limit only
once its dead-letter stream holds less than the new one.

`sync.listTopics({ idPrefix })` lists topics that exist on the broker in this
namespace, including topics that no process has declared. `topic.destroy()`
deletes a topic's event and dead-letter streams without provisioning them.
Together they retire per-entity topics from older releases. Delete a topic
only after its events are captured in durable state or another topic.
[Notebook document log](/en/docs/operations/notebooks-document-log) shows one
such migration.

## Consume durable events

```ts
const worker = await inventoryEvents().process({
  consumer: "search-index",
  start: "earliest",
  delivery: { maxAttempts: 4, backoffMs: [1_000, 5_000, 30_000] },
}, async (event) => {
  await updateSearchIndex(event.data.itemId);
});
```

The same consumer name shares deliveries across instances. Different names
receive independent copies. Successful handlers acknowledge; errors retry and
then move to that consumer's dead-letter stream. Execution is at least once.
Stop and drain the returned worker before releasing its dependencies.

## Replay and resume

```ts
const topic = inventoryEvents();
const until = await topic.latestCursor();
if (until) {
  for await (const event of topic.replay({ after: savedCursor, until, signal })) {
    await applyEvent(event);
  }
}
```

`replay()` is finite; without `until`, it captures the head at startup.
`follow()` replays and stays open. Omitting `after` on `follow()` starts from the
first retained event, which is unsuitable for a fresh live-only connection.

Cursors use the opaque `s6t.…` format. Do not parse them as Redis IDs or compare
them lexically. `cursorSequence()` and `cursorAt()` translate between a topic's
cursor and a persisted numeric stream sequence when the application needs it.

`RetentionGapError` means the requested history is incomplete.
`CursorMismatchError` means the cursor belongs to another topic. Reload an
authorized snapshot; never save a partial replay as a complete document.

On a shared topic, a gap means the retained window no longer starts right
after your cursor. Sync cannot tell whether the removed events belonged to
your tenant, so it reports every removal past the cursor. Other tenants'
events between yours are never a gap. A cursor saved only when its own tenant
changes goes stale once other tenants push the window past it. Store a
watermark instead:

```ts
const head = await topic.head(); // before latestCursor()
const latest = await topic.latestCursor({ tenantId });
// ...apply the tenant's events up to `latest` and persist the result...
await saveCursor(latest && topic.cursorSequence(latest) > topic.cursorSequence(head) ? latest : head);
```

Reading `head()` first guarantees that the tenant has no event between
`latest` and `head`. Refresh the stored cursors of idle tenants the same way
before the window reaches them, for example in a periodic reconcile.

## Follow a topic in a process

`live({ tenantId, signal })` is a best-effort broadcast. It has no cursor or
replay and filters the tenant on the server. Use it when missed events are
harmless and the process can read canonical state again.

`hub({ tenantId })` shares one follower among the subscribers of a process,
each with its own cursor, and retires it when the last subscriber leaves:

```ts
for await (const event of inventoryEvents().hub().subscribe({ after, signal })) {
  await apply(event);
}
```

Read `after` with `head()` before loading the state the subscriber starts
from, so a change made meanwhile is not lost. `head()` returns the newest
cursor of the whole topic in one lookup, or `cursorAt(0)` when it is empty.
`hub().subscribe()` without `after` is live-only. A subscriber that falls
behind receives `RetentionGapError` and must read its state again.

Do not stream committed changes to browsers from a topic. Updates that follow
a database change belong in that change's transaction, and open tabs receive
them through [Live updates](/en/docs/automation/live-updates), which also replays missed
updates and checks each reader's access when it delivers. Publishing to a
topic after the commit loses the update when the publish fails.

Foreground Cloud notifications resume with topic cursors. After an invalid or
expired cursor, notifications reconnect from the current head. Saved
notification history remains available.
