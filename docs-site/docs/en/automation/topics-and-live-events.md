---
title: Topics and live events
navTitle: Topics and live events
section: Automation
order: 640
description: Publish transient events to application processes and connected browsers.
tags: [topics, events, realtime]
updated: 2026-09-07
---

# Topics and live events

Use a Sync topic for retained events, independent consumer groups, or live
updates. Cloud owns the NATS connection; declare topics through `lazySync()`.

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
with `ResourceDriftError`; it does not update the existing resource.

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

## Stream live updates

Use `live({ tenantId, signal })` for best-effort broadcast. It has no cursor or
replay and filters the tenant on the server. It is suitable when missed events
are harmless and the application can read canonical state again.

For resumable browser streams, use a memoized hub:

```ts
const topic = inventoryEvents();
const after = await topic.head();
const snapshot = await loadAuthorizedSnapshot();
sendSnapshot(snapshot);
for await (const event of topic.hub().subscribe({ after, signal })) {
  sendToBrowser(event);
}
```

Capturing the cursor before the snapshot prevents writes during the snapshot
read from disappearing. `head()` returns the newest cursor of the whole topic
in one lookup, or `cursorAt(0)` when it is empty; use
`latestCursor({ tenantId })` when the stream is filtered to one tenant.
Deduplicate replayed changes against the snapshot.
`hub().subscribe()` without `after` is live-only. Slow subscribers can receive
`RetentionGapError` and must resynchronize.

A hub shares one follower among local subscribers and retires it when the
last subscriber leaves, so a connection ends its subscription rather than
closing the hub. Replay, follow, and hubs filter tenants locally, so one hub
per tenant reads the full topic stream for each active tenant. Prefer
server-filtered `live()` for transient high-volume fan-out, or separate topics
when retained data is naturally isolated.

Foreground Cloud notifications resume with these cursors. After an invalid or
expired cursor, notifications reconnect from the current head. Saved
notification history remains available.

Use [Realtime UI](/en/docs/frontend/realtime-ui) for browser integration. Validate
untrusted payloads at the application boundary.
