---
title: Live updates
navTitle: Live updates
section: Automation
order: 645
description: Write an application's live updates in the transaction that makes the change and serve them to its open tabs over one socket.
tags: [live, realtime, outbox, transactions, websocket]
updated: 2026-10-05
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
does not derive it from the process. Define the updates once, at module
scope, in a module that the application imports before `app.start()`.
`app.start()` then publishes the pending updates from every replica. Writing
an update needs no started application, so tests can call the code that
writes it directly.

Another application may import the definition to read its `cursor()` or to
write updates; only the application with that ID publishes and serves them.
`app.start()` refuses to start a process that mounts `routes()` of another
application. Assistant, for example, reads the cursor of Core's AI live
updates for its server-rendered page.

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

Every replica forgets its cached decisions for the key and checks the key's
subscribers again before it delivers anything after the update, so a viewer
who lost the key loses it at once. Right after, without holding up delivery,
it runs `keys()` for its collections; a collection that gained a key loads its
state again. Access updates that arrive while that runs share one more run.

An access update checks only the subscribers of the key it names. When one
change decides who may read several keys, for example a grant on a Base whose
readers also follow its tables, publish an access update for each of those
keys in the same transaction.

`data` is optional; with it, viewers who keep access receive the update too.
`publish()` writes the access change as a row of its own before the data, so
data above 32 KiB, which becomes a resync, does not lose it.

### Write from a database trigger

A trigger writes an update with Core's `events.enqueue()`, in the transaction
of the statement that fired it. Build the same row that `publish()` writes: an
update ID, the application ID, `live`, the key, and an envelope with `v` set
to `1`, the key as `k`, and the data as `d`.

```sql
CREATE FUNCTION inventory.publish_item_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM events.enqueue(
    gen_random_uuid(),
    'inventory',
    'live',
    NEW.warehouse_id::text,
    jsonb_build_object(
      'v', 1,
      'k', NEW.warehouse_id::text,
      'd', jsonb_build_object('type', 'item.changed', 'itemId', NEW.short_id)
    ),
    NEW.warehouse_id::text || ':' || NEW.short_id
  );
  RETURN NEW;
END;
$$;
```

- The last argument, the coalesce key, joins the updates of one transaction:
  updates of the application with the same coalesce key are written once, at
  the position of the first, with the data of the last. A bulk change that
  fires the trigger for many rows of one item then writes one update. Pass
  `NULL` to write every update. Keep coalesce keys under 600 characters.
- Nothing checks the data against `event` when it is written. The browser
  validates it and loads its state again when it cannot read an update.
- Data above 32 KiB becomes a resync, as with `publish()`.
- Call `wake()` after the commit, or the update is published within about a
  second.

Mail writes its updates this way, from a trigger on its activity log, with
one update per conversation and transaction. The AI tables write Core's AI
live updates this way, one for each user who reads the changed data, without
a coalesce key, because each update names its own changed views. Grids writes the updates of
record changes from the function that also records its own record events,
with one update per record and table in a transaction.

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
- `keys(scope, viewer)` returns the keys that the subscription follows, or
  `null` when the resource does not exist or the viewer may not read it. Cloud
  follows the first 1,000 keys and logs a warning about the rest.
- `authorize(key, viewers)` returns the IDs of the viewers who may read `key`.
  Cloud calls it with up to 500 viewers at once, so check them together
  instead of one by one: `getEffectivePermissions()` from `@k2b/cloud/server`
  decides every viewer's `accessSubject` with one query, by the same rules as
  `getEffectivePermission()`. Apply the same role and credential rules as the
  API.
- `collection: true` marks a channel whose key set can change without an
  update, such as "every book I can read". Cloud runs `keys()` again every
  minute and after an access update. A collection may start with no keys.

The channels are passed to `routes()`, not to `defineLive()`: the services that
decide access usually also publish updates, so the definition must not import
them.

A viewer carries `id`, `actor` and `accessSubject` as on an API request, and
the credential's `scopes`. Use `accessSubject` for grants and `actor` for
roles. `id` starts with `user:<id>` or `service_account:<id>` and adds
everything of the credential that can change a decision: `:app` for a phone's
app session, which never holds the `admin` role, and the scopes of an API key
or OAuth token. Viewers with the same `id` share decisions, so a person's web
tabs are checked together, but an API key without `read` never inherits the
decision of another key of the same account.

The socket authenticates like any API request: a session cookie, an API key,
or an OAuth token. A socket that may not be served opens, receives `error`,
and closes with `1008`, so the browser client stops instead of retrying. The
gateway accepts the browser's socket before the application sees it, so a
refused handshake would only reach the browser as a retryable `1012`.

| Code | Cause |
| --- | --- |
| `login_required` | No credential, or the session or token has ended |
| `forbidden_origin` | A session whose `Origin` differs from the origin of the `app.url` setting |
| `missing_scope` | An OAuth token without `read` (or `admin`), as on other read routes |

Browsers send `Origin` with every socket, and the gateway forwards it. A
socket without `Origin` comes from a client that is not a web page, and it is
served like any other request with that credential.

An API key reads what the application's `authorize` allows for its scopes,
as on the API.

One viewer can open 16 sockets per replica. Opening sockets is limited to 5
per second for each signed-in person, and for each client address for API
keys, OAuth tokens, and requests without a credential.

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
| Access lost, while updates arrive | 2 seconds (the decision cache, counted from the check) |
| Access lost on a quiet subscription | 10 seconds (a sweep checks every key) |
| Role or account change, such as a removed administrator | 10 seconds (the sweep loads the viewer again) |
| Session or token ended | 10 seconds; the socket closes with `1008` |
| Key gained through a group, without an update | 60 seconds (collections) |

Updates that were already sent can still arrive after a revocation: what
waits in the application's send buffer (256 KiB) and in the gateway, which
holds up to 4 MiB for each browser socket.

A viewer who loses access to a single-key subscription receives `revoked`
with `access_denied`; a replay in progress stops. A collection drops the key
and receives `resync`. When `authorize`, `keys()`, or the credential check
throws or does not answer within 10 seconds, the socket closes with `1011`
and nothing is skipped: the tab reconnects and resumes from its cursor.

A collection that comes back from its cursor receives `resync` when its
replica has already read an access update published after that cursor, even
one of a key it does not follow now: Cloud does not know which keys the tab
had, and only loading the state again removes a key it lost. An access update
the replica reads only after the tab subscribed, usually one made within the
second before, shows at the next reload, as does a key gained or lost through
a group without an update.

A replay uses the same access decisions as live delivery, so the table above
applies to it too. A subscription that comes back from its cursor while its
replica reads an access update receives `resync` instead of a replay, so an
answer from before that update releases nothing published after it.

### Close codes

| Code | Meaning | The browser client |
| --- | --- | --- |
| `1008` | Refused socket, session ended, protocol violation | stops |
| `1011` | A check failed | reconnects with backoff |
| `1012` | The replica stops | reconnects with backoff |
| `1013` | The client reads too slowly (256 KiB waiting), or too many sockets or messages | reconnects with backoff |

A message from the tab is at most 16 KiB, and a socket holds at most 16
subscriptions. At most 24 messages may wait, so a reconnect can send every
subscription at once. A replay waits at most 10 seconds in total for a full
send buffer, and the updates that arrive meanwhile wait in a second buffer of
at most 256 KiB.

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
- **Batches.** A replica publishes up to 100 pending updates at a time:
  different keys in parallel, the updates of one key in order. Updates wait
  behind the ones committed before them, so a burst on one key, such as a
  bulk change of 10,000 items, delays later updates by the few seconds it
  takes to publish. Replicas take turns to claim a batch and publish their
  batches at the same time; a backlog, such as after a NATS outage, does not
  slow down a claim.
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

Update Core before the applications that define live updates. Contacts,
Spaces, Mail, and Grids are the built-in applications that do. Core defines
the AI live updates itself and starts publishing them after its migration.

A replica that stops closes its sockets with `1012`, also those that open
while it stops; the tabs reconnect to another replica and resume from their
cursors. Each replica reads the topic once to fill its window, not once per
socket. Plan the send buffers for each socket that reads too slowly: 256 KiB
in the application, twice that during a replay, and up to 4 MiB in the
gateway, which closes the browser socket with `1013` above it.

Live sockets have no metrics of their own. Each replica logs under
`events:live`, with the application ID:

| Log | Meaning |
| --- | --- |
| `Live sockets closed: <check> failed` | `authorize`, `keys()`, or the credential check threw or took longer than 10 seconds; the sockets reconnect |
| `Live socket closed because the client reads too slowly` | A socket exceeded its send buffer |
| `A live subscription follows only the first keys of its scope` | `keys()` returned more than 1,000 keys |
| `Live follower failed; it resumes` | Reading the topic failed; the replica retries every second |
| `Live updates wait to be published` | Updates older than 60 seconds are still in the outbox |

Continue with [Realtime UI](/en/docs/frontend/realtime-ui) for the browser,
with [Topics and live events](/en/docs/automation/topics-and-live-events) for
topics that other consumers read, or with
[Migrations and transactions](/en/docs/data/migrations-and-transactions) for
transaction boundaries.
