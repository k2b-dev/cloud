---
title: Live updates
navTitle: Live updates
section: Automation
order: 645
description: Write an application's live updates in the transaction that makes the change.
tags: [live, realtime, outbox, transactions]
updated: 2026-10-03
---

# Live updates

A live update tells an application's own open tabs that something changed.
Write it with `defineLive()` in the Postgres transaction that makes the
change. A rollback writes nothing. A commit publishes the update at least
once, in order per key, even when NATS is briefly unavailable or the process
stops right after the commit.

Live updates are internal to the application and may change with its UI.
Facts that other applications, workflows, or scripts observe are not live
updates.

## Define the updates

```ts
import { defineLive } from "@k2b/cloud/events";
import { z } from "zod";

export const inventoryLive = defineLive({
  appId: "inventory",
  event: z.discriminatedUnion("type", [
    z.object({ type: z.literal("item.changed"), itemId: z.string() }),
    z.object({ type: z.literal("item.deleted"), itemId: z.string() }),
  ]),
});
```

`appId` is the ID from the application's declaration; `app.start()` refuses
to start when a definition names another application. Define the updates once,
at module scope, in a module that the application imports before
`app.start()`. `app.start()` then publishes the pending updates from every
replica. Writing an update needs no started application, so tests can call the
code that writes it directly.

## Publish in the transaction

```ts
await sql.begin(async (tx) => {
  await tx`UPDATE inventory.items SET quantity = ${quantity} WHERE id = ${itemId}::uuid`;
  await inventoryLive.publish(tx, {
    key: warehouseId,
    data: { type: "item.changed", itemId: publicItemId },
  });
});
inventoryLive.wake();
```

- `key` routes the update, usually to the container whose readers may see
  it, such as a warehouse or a book. It has 1 to 600 characters.
- One update has one key. A change that concerns two containers publishes
  twice. Publish a move as a removal keyed by the source and an addition keyed
  by the target, so a reader of one container does not learn the other.
- `data` travels as JSON. `publish()` validates its JSON form against `event`,
  and subscribers receive the schema's output, so transforms and defaults run
  once, for the subscriber. A violation throws and rolls back the transaction,
  like any other failed statement. A value that JSON cannot carry, such as a
  `Date` for `z.date()`, is a violation: send an ISO string, or use
  `z.coerce.date()`.
- `data` must not contain anything that a reader of `key` may not see. There
  is no per-reader projection.
- Data larger than 32 KiB never fails the write. The update becomes a reload
  hint for `key` instead; subscribers receive `data: null`.
- `wake()` after the commit publishes now. Without it, the update is
  published within about a second.

Publish only when the transaction changed something. A write that is refused
or finds no row should return before `publish()`.

## Read the updates for a socket

`subscribe()` is interim: it reads the updates for the application's own
socket until Cloud provides shared live routes for sockets. A later release
can replace it; [Deprecations](/en/docs/reference/deprecations-and-migrations)
then names the migration.

```ts
// SSR: capture the cursor before the snapshot it belongs to.
const cursor = await inventoryLive.cursor();
const snapshot = await loadAuthorizedSnapshot();

// Socket: forward updates after the browser's cursor.
for await (const update of inventoryLive.subscribe({ after: cursor, signal })) {
  if (!(await mayRead(viewer, update.key))) continue;
  if (update.data === null) reloadState(update.key);
  else send({ cursor: update.cursor, event: update.data });
}
```

`subscribe()` shares one reader of the application's topic among all
subscribers in the process. It throws `CursorMismatchError` for a cursor from
another topic and `RetentionGapError` when the cursor has left the retained
window; reload the authorized snapshot in both cases. Check access to `key`
when you forward an update, not only when the socket opens. Use
[Realtime UI](/en/docs/frontend/realtime-ui) for the browser side.

## Know the guarantees

- **At least once.** Retries and the SSR cursor can repeat an update. Apply
  updates idempotently, and guard them with a revision where order matters.
- **Order per key.** Updates of one key arrive in publication order. Within a
  transaction, that is the call order. Across transactions, it is the commit
  order when the writers lock the same row, which is normal for one resource.
- **No dead state.** A failed publish retries with a backoff of up to five
  minutes and does not block other keys. Updates that wait longer than 60
  seconds are logged once a minute as `Live updates wait to be published`.
- **Nothing kept after delivery.** Published updates are deleted from the
  outbox, which holds only pending updates.

The application's topic, `cloud:live:<application ID>`, retains updates for
24 hours or 64 MiB. Its configuration is fixed for every installation.

## Deploy

Core creates the platform outbox, the `events.outbox` table and the
`events.enqueue()` function, in its migration. Every application uses the same
table in the shared platform database. An application that defines live
updates does not start before Core has created it:

```text
"inventory" writes live updates to events.outbox, which does not exist.
Update Cloud Core first: its migration creates the outbox.
```

Update Core before the applications that define live updates. Contacts is the
first built-in application that does.

Continue with [Topics and live events](/en/docs/automation/topics-and-live-events)
for topics that other consumers read, or with
[Migrations and transactions](/en/docs/data/migrations-and-transactions) for
transaction boundaries.
