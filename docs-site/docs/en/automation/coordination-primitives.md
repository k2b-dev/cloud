---
title: Coordination primitives
navTitle: Coordination primitives
section: Automation
order: 650
description: Coordinate distributed application instances with rate limits, mutexes, and ephemeral state.
tags: [mutex, ratelimit, ephemeral]
updated: 2026-07-27
---

# Coordination primitives

Use the `@k2b/sync` primitives when app instances need shared,
short-lived coordination state.

These primitives use Valkey. They are not a replacement for durable domain
records in Postgres.

## Use a distributed mutex

```ts
import { mutex } from "@k2b/sync";

const stockLock = mutex({
  id: "inventory.stock",
  defaultTtl: 10_000,
});

await stockLock.withLockOrThrow(`item:${itemId}`, async () => {
  await adjustStock(itemId, delta);
});
```

A lock expires after its TTL so a crashed owner cannot hold it forever.
Set the TTL longer than the critical section. Call `extend()` before the lock
expires when long work cannot be bounded.

Only the current owner can extend or release a lock. `withLock()` returns null
when acquisition fails. `withLockOrThrow()` throws `LockError`.

A mutex does not make a non-idempotent external effect safe after a crash. Use
a database transaction or a workflow effect class for that.

## Apply a sliding rate limit

```ts
import { ratelimit } from "@valentinkolb/cloud/server";

const exports = ratelimit({
  id: "inventory.exports",
  limit: 10,
  windowSecs: 60,
});

const result = await exports.check(`user:${userId}`);
if (result.limited) {
  return c.json(
    { error: "Too many exports", retryAfterMs: result.resetIn },
    429,
  );
}
```

`check()` counts the current request. The result includes remaining capacity
and milliseconds until reset.

Use [request middleware](/en/docs/server/middleware) for HTTP route limits.
Use the primitive when the limit belongs to domain work outside one router.

## Store ephemeral state

```ts
import { ephemeral } from "@k2b/sync";

const presence = ephemeral<{ userId: string }>({
  id: "inventory.editors",
  ttlMs: 30_000,
});

await presence.upsert({
  tenantId: itemId,
  key: sessionId,
  value: { userId },
});

await presence.touch({ tenantId: itemId, key: sessionId });

const snapshot = await presence.snapshot({ tenantId: itemId });
```

Use `tenantId` for isolated state and quotas. Use `prefix` to filter keys
inside one tenant.

Readers receive upsert, touch, delete, and expiry events. An overflow event
means the cursor fell behind. Read a new snapshot.

Entries disappear after TTL expiry. Do not store permissions, business
records, or the only copy of work in progress.
