---
title: Live updates
navTitle: Live updates
section: Automation
order: 645
description: Write an application's live updates in the transaction that makes the change and serve them to its open tabs over one socket.
tags: [live, realtime, outbox, transactions, websocket]
updated: 2026-10-04
---

# Live updates

A live update tells an application's own open tabs that something changed.
Write it with `defineLive()` in the Postgres transaction that makes the
change. A rollback writes nothing. A commit publishes the update at least
once, in order per key, even when NATS is briefly unavailable or the process
stops right after the commit.

The same definition serves the updates to browsers: one socket per
application at `/api/<application ID>/live`, with named channels. Cloud checks
each reader's access when it delivers an update, not only when the socket
opens.

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

`appId` is required and is the ID from the application's declaration. Cloud
does not derive it from the process, and `app.start()` refuses to start when a
definition names another application. Define the updates once, at module
scope, in a module that the application imports before `app.start()`.
`app.start()` then publishes the pending updates from every replica. Writing
an update needs no started application, so tests can call the code that
writes it directly.

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

- `key` routes the update to the subscriptions that follow it, usually the
  container whose readers may see it, such as a warehouse or a book. It has 1
  to 600 characters, and it is the unit that `authorize` decides.
- One update has one key. A change that concerns two containers publishes
  twice. Publish a move as a removal keyed by the source and an addition keyed
  by the target, so a reader of one container does not learn the other.
- `data` travels as JSON. `publish()` validates its JSON form against `event`.
  A violation throws and rolls back the transaction, like any other failed
  statement. A value that JSON cannot carry, such as a `Date` for `z.date()`,
  is a violation: send an ISO string. The browser validates the data again
  when it receives it.
- `data` must not contain anything that a reader of `key` may not see. There
  is no per-reader projection.
- Data larger than 32 KiB never fails the write. Subscribers of `key` receive
  a resync instead and load their state again.
- `wake()` after the commit publishes now. Without it, the update is
  published within about a second.

Publish only when the transaction changed something. A write that is refused
or finds no row should return before `publish()`.

### Announce access changes

When a change decides who may read a key, for example a new member of a
warehouse, publish it with `access: true`:

```ts
await inventoryLive.publish(tx, { key: warehouseId, access: true });
```

Before it delivers that update, every replica forgets its cached decisions
for the key, checks the key's subscribers again, and runs `keys()` for its
collections. A viewer who lost the key loses it at once, and a collection
that gained a key loads its state again. `data` is optional; with it, viewers
who keep access receive the update too.

## Serve the channels

A channel is what a tab subscribes to. Declare the channels next to the
services that decide access, and mount them once at
`/api/<application ID>/live`:

```ts
import type { LiveViewer } from "@k2b/cloud/events";

const inventoryChannels = {
  warehouse: {
    scope: z.object({ warehouse: z.string() }).strict(),
    keys: async ({ warehouse }: { warehouse: string }) => {
      const id = await warehouseIdFromPublicId(warehouse);
      return id ? [id] : null;
    },
    authorize: (warehouseId: string, viewers: readonly LiveViewer[]) => readersOfWarehouse(warehouseId, viewers),
  },
};

const api = new Hono<AuthContext>().route("/live", inventoryLive.routes(inventoryChannels));
```

- `scope` validates the subscription the tab sends, for example one
  warehouse. An invalid scope ends the socket.
- `keys(scope, viewer)` returns the keys that the subscription follows, 1 to
  1,000 of them, or `null` when the resource does not exist or the viewer may
  not read it.
- `authorize(key, viewers)` returns the IDs of the viewers who may read `key`.
  Cloud calls it with up to 500 viewers at once, so check them together
  instead of one by one. Use the same permission service as the API.
- `collection: true` marks a channel whose key set can change without an
  update, such as "every book I can read". Cloud runs `keys()` again every
  minute and after an access update. A collection may start with no keys.

The channels are passed to `routes()`, not to `defineLive()`: the services that
decide access usually also publish updates, so the definition must not import
them.

A viewer carries `id` (`user:<id>` or `service_account:<id>`), `actor` and
`accessSubject` as on an API request, and the credential's `scopes`.
Authorization is cached per viewer, not per credential.

The socket authenticates like any API request: a session cookie, an API key,
or an OAuth token.

- A socket signed in with a session must come from the Cloud origin, the
  origin of the `app.url` setting. Other origins receive `403`.
- An OAuth token needs the `read` scope (or `admin`), as other read routes do.
  Without it, the socket receives `403`.
- One viewer can open 16 sockets per replica; a principal can open 5 per
  second.

[Realtime UI](/en/docs/frontend/realtime-ui) subscribes from the browser.

### Read the cursor before the snapshot

```ts
const cursor = await inventoryLive.cursor();      // first
const snapshot = await loadAuthorizedSnapshot();  // then
return render(<Warehouse cursor={cursor} snapshot={snapshot} />);
```

Reading the cursor first means that a change made while the snapshot loads is
delivered afterwards. An island without a cursor subscribes at the current
position and should load its data after it subscribed.

## Know what a subscription receives

The tab sends only `sub` and `unsub`. Writes, read state, typing, and focus go
over HTTP or `sync.ephemeral`.

| Message | Meaning |
| --- | --- |
| `ready` | The subscription is active; the events it missed since its cursor were replayed before it. |
| `event` | One update of a followed key, in topic order. |
| `progress` | Every update up to this cursor was sent on the socket; quiet subscriptions move their cursor along. |
| `resync` | Load the state again; updates after this cursor follow. |
| `revoked` | The subscription ended: `not_found` when it starts, `access_denied` when the viewer loses access. |
| `error` | The socket closes right after it. |

Each replica keeps the latest 5,000 updates of the application (at most
32 MiB). A tab that comes back within that window receives what it missed and
loads nothing. An older cursor, a cursor from another topic, or a cursor
beyond the topic's head receives `resync`.

`resync` is a normal path: an oversized update, a collection whose keys
changed, and a cursor outside the window all end there.

### Access at delivery

| Change | Reaches the tab within |
| --- | --- |
| Update published with `access: true` | at once |
| Access lost, while updates arrive | 2 seconds (the decision cache) |
| Access lost on a quiet subscription | 10 seconds (a sweep checks every key) |
| Session or token ended | 10 seconds; the socket closes with `1008` |
| Key gained through a group, without an update | 60 seconds (collections) |

A viewer who loses access to a single-key subscription receives `revoked`
with `access_denied`. A collection drops the key and receives `resync`. When
`authorize` or the credential check throws, the socket closes with `1011` and
nothing is skipped: the tab reconnects and resumes from its cursor.

### Close codes

| Code | Meaning | The browser client |
| --- | --- | --- |
| `1008` | Session ended, protocol violation | stops |
| `1011` | A check failed | reconnects with backoff |
| `1012` | The replica stops | reconnects with backoff |
| `1013` | The client reads too slowly (256 KiB waiting), or too many sockets or messages | reconnects with backoff |

A message from the tab is at most 16 KiB; at most 8 may wait, and a socket
holds at most 16 subscriptions.

## Know the guarantees

- **At least once.** Retries, reconnects, and the SSR cursor can repeat an
  update. Apply updates idempotently, and guard them with a revision where
  order matters.
- **Order per key.** Updates of one key arrive in publication order. Within a
  transaction, that is the call order. Across transactions, it is the commit
  order when the writers lock the same row, which is normal for one resource.
  A subscription receives its updates in topic order.
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

A replica that stops closes its sockets with `1012`; the tabs reconnect to
another replica and resume from their cursors. Each replica reads the topic
once to fill its window, not once per socket. Plan the send buffer as 256 KiB
for each socket that reads too slowly.

Continue with [Realtime UI](/en/docs/frontend/realtime-ui) for the browser,
with [Topics and live events](/en/docs/automation/topics-and-live-events) for
topics that other consumers read, or with
[Migrations and transactions](/en/docs/data/migrations-and-transactions) for
transaction boundaries.
