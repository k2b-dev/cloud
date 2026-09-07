---
title: Coordination primitives
navTitle: Coordination primitives
section: Automation
order: 650
description: Coordinate distributed application instances with rate limits, mutexes, and ephemeral state.
tags: [mutex, ratelimit, ephemeral]
updated: 2026-09-07
---

# Coordination primitives

Use NATS-backed Sync mutexes and ephemeral state for short-lived coordination
between application instances. Keep permissions and business records in
Postgres. Cloud rate limits remain on Valkey.

## Use a distributed mutex

```ts
import { lazySync } from "@valentinkolb/cloud";

const stockLock = lazySync((sync) => sync.mutex({
  id: "inventory.stock",
  ttlMs: 10_000,
  retry: { maxAttempts: 1 },
}));

const result = await stockLock().withLock({ resource: `item:${itemId}` }, async (lock) => {
  return adjustStock(itemId, delta, lock.fence);
});
```

`withLock()` returns null when acquisition fails. `maxAttempts: 1` means one
immediate attempt; the default retries acquisition up to ten times, 200 ms apart.
A lock expires after its TTL. Extend it before expiry with
`extend(lock, { ttlMs })`; false means ownership was lost. `release(lock)` checks
the owner token too.

The monotonic `fence` is a bigint. Persist and compare it at the external write
boundary when an expired owner could still write. A lease alone cannot stop
that process. Convert a fence to a string before JSON serialization.

## Apply a sliding rate limit

```ts
import { ratelimit } from "@valentinkolb/cloud/server";

const exports = ratelimit({ id: "inventory.exports", limit: 10, windowSecs: 60 });
const result = await exports.check(`user:${userId}`);
if (result.limited) {
  return c.json({ error: "Too many exports", retryAfterMs: result.resetIn }, 429);
}
```

`check()` counts the current request and returns remaining capacity and
milliseconds until reset. Use [request middleware](/en/docs/server/middleware)
for HTTP limits, or this Cloud primitive for work outside one router. Sync v6
does not export a rate limiter.

## Store ephemeral state

```ts
const presence = lazySync((sync) => sync.ephemeral<{ userId: string }>({
  id: "inventory.editors",
  ttlMs: 30_000,
  maxValueBytes: 4_096,
}));

await presence().upsert({ tenantId: itemId, key: sessionId, value: { userId } });
const renewed = await presence().touch({ tenantId: itemId, key: sessionId });
const snapshot = await presence().snapshot({ tenantId: itemId });

for await (const event of presence().watch({ tenantId: itemId, signal })) {
  // Without `after`, watch first emits existing entries as upserts.
  if (event.type === "resync_required") break; // Reopen the watch for fresh state.
  applyPresenceEvent(event);
}
```

`touch()` returns a boolean; recreate the entry if it no longer exists.
`delete()` removes a key. Snapshot and watch entries contain `updatedAt` and
`revision`, but no creation or expiry timestamps. Store any creation timestamp
needed by the application in the value. The snapshot's `revision` can be passed
as `watch({ after })` when snapshot and watch need separate handling.

`tenantId` partitions logical state; it is not an authorization boundary.
`prefix` filters keys within a tenant. History overflow produces
`resync_required` and closes the iterator. Reopen a watch to receive current
entries, replacing stale local state. Entries expire automatically; they must
never be the only copy of work in progress.
