---
title: Realtime UI
navTitle: Realtime UI
section: Frontend
order: 870
description: Update an open page from its application's live channels while preserving reload and recovery behavior.
tags: [realtime, websocket, cursors]
updated: 2026-10-04
---

# Realtime UI

Realtime updates enhance a server-rendered page. They do not replace its
reload path.

Start with an authorized snapshot and the cursor read before it. Subscribe to
the application's live channel from that cursor. Apply each event, or load the
state again when the server asks for it.

The server side, channels, and access rules are described in
[Live updates](/en/docs/automation/live-updates).

## Subscribe to a channel

```tsx
import { liveConnection } from "@k2b/cloud/browser/live";
import { onCleanup, onMount } from "solid-js";

onMount(() => {
  const subscription = liveConnection("/api/inventory/live").subscribe("warehouse", { warehouse: props.warehouseId }, {
    cursor: props.cursor,
    parse: (data) => InventoryEventSchema.parse(data),
    apply: async (events) => {
      for (const { data } of events) await inventory.invalidate(data);
    },
    resync: () => inventory.refresh(),
    revoked: () => replacePage(),
    unavailable: () => replacePage(),
  });
  onCleanup(() => subscription.close());
});
```

- `liveConnection(url)` opens one socket per URL and page. Every
  subscription on it shares that socket, and the socket closes when the last
  subscription closes.
- `cursor` is the cursor that the server read before the snapshot. With
  `null`, the subscription starts at the current position; load the data after
  that.
- `parse` validates each event. Data that does not parse loads the state again
  through `resync`.
- `apply` receives up to 100 events in order. It must be idempotent: a
  reconnect or a retry can repeat an event. When more than 1,000 events wait
  for it, they collapse into one `resync`.
- `resync` loads the canonical state again. Events that arrive meanwhile are
  applied after it. A reconnect while it runs resumes after its cursor.
- `revoked` ends the subscription: the resource is gone or no longer readable.
- `unavailable` reports that live updates stopped: the session ended, the
  socket was refused, or `apply` or `resync` failed four times (after 1, 3,
  and 9 seconds). A subscription that its owner closed reports nothing, even
  when an `apply` or a retry was still pending.

The client owns the socket, visibility, reconnect backoff, connection
deadlines, recovery when the tab or network returns, cursors, retries, and
disposal. The application owns its channels, validation, and what an event
changes on the page.

## Advance only after coverage

A subscription moves its cursor only after `apply` or `resync` resolved, or at
a `ready` or `progress` mark that follows them. A reconnect resumes from that
cursor, so an event whose apply did not finish arrives again.

For a server-backed snapshot, resolve `apply` only after the matching query
invalidation has committed a covering snapshot. If one event affects several
queries, wait for all of them. Apply an event directly only when it contains
the complete authoritative projection.

A query whose owner is disposed while it refreshes rejects its invalidation,
for example a list column that the refreshed snapshot replaced. The disposed
query no longer shows data, so treat that rejection as covered, not as a
failure.

See [Server-backed state](/en/docs/frontend/server-backed-island-state) for the
query invalidation contract.

## Reload only on resync

A returning tab opens a new socket and subscribes again from its cursor. The
server replays what the tab missed and confirms with `ready`. A `ready` never
loads anything again; only a `resync` does. A tab that comes back after a
short while therefore shows the missed changes without reloading its data.

`progress` moves the cursor of a quiet subscription along, so it stays inside
the window the server can replay.

Replay covers only the channel's own events. Refresh on your own trigger when
the values a page shows change without an event: when a page shows values
relative to the current day, such as overdue or due-today lists, refresh when
the day changed since the snapshot, because no event announces a new day.

## Recover after interruptions

With the default `activity: "visible"`, a hidden tab closes its socket. Pass
`liveConnection(url, { activity: "always" })` to keep it open while the tab is
hidden.

A handshake that has not opened after 10 seconds is closed and retried with
backoff. When the tab becomes visible or the window regains focus, a stalled
handshake or a pending backoff is replaced by an immediate attempt. When the
browser reports `online`, a handshake still in progress is replaced too,
because it started on the network that was gone. An open socket is left
alone.

Close code `1008` stops live updates and calls `unavailable`. Every other
close reconnects with backoff, including `1011` (a check failed), `1012` (the
replica restarts; the gateway also sends it for a failed upstream connection),
and `1013` (try again later).

## Preserve reload behavior

The URL must still identify the visible resource and view. A reload asks the
server for a fresh authorized result. Do not keep the only copy of edits or
selected resources in the socket client.

Reload automatically, from `resync`, `revoked`, or `unavailable`, only through
`reloadOnce(key)` from `@k2b/cloud/browser/reload`. It reloads at most once
per key within 30 seconds in the tab, so a condition that persists after the
reload cannot reload the page in a loop. When it returns `false`, keep the
page usable and offer a reload action in a persistent toast. A banner above
the content would push the page down; a reconnect that succeeds shows nothing.

```ts
import { reloadOnce } from "@k2b/cloud/browser/reload";
import { toast } from "@k2b/ui";

const replacePage = () => {
  subscription.close();
  if (reloadOnce(`inventory:live:${location.pathname}`)) return;
  toast(t.liveUpdatesStopped, {
    duration: 0,
    action: { label: t.reload, onClick: () => window.location.reload() },
  });
};
```

Wait for open editors to close before an automatic reload, so a reload does
not discard a draft. `reloadOnce` also returns `false` when `sessionStorage`
is unavailable. A reload that follows an explicit user action does not need
the guard.

An ended session reaches the page as `unavailable`. Reload, so the page's
route policy sends the person to sign-in with a return URL. Do not navigate to
the sign-in page yourself, and when `reloadOnce` returns `false`, offer the
reload button, not a sign-in link: a manual reload still reaches sign-in when
the session has expired.

## Sockets that are not live channels

`createLiveWebSocket` from the same entry point is the transport under
`liveConnection`. Use it only for a socket with its own protocol, such as a
collaborative editor, where the application authorizes the subscription and
every resource it streams. Its `subscribe` message is sent when the socket
opens, `markApplied()` records the cursor to resume from, and `1008` is
terminal by default.

For server event semantics, see
[Live updates](/en/docs/automation/live-updates).
