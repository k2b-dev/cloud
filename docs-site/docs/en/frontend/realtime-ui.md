---
title: Realtime UI
navTitle: Realtime UI
section: Frontend
order: 870
description: Update an open page from application events while preserving reload and recovery behavior.
tags: [realtime, websocket, cursors]
updated: 2026-09-23
---

# Realtime UI

Realtime updates enhance a server-rendered page. They do not replace its
reload path.

Start with an authorized snapshot. Subscribe from that snapshot's cursor.
Cover each event with an authoritative state update, then advance the cursor.

## Connect a live WebSocket

```tsx
import { createLiveWebSocket } from "@k2b/cloud/browser/live";
import { onCleanup, onMount } from "solid-js";

const live = createLiveWebSocket<InventoryEvent>({
  url: "/api/inventory/ws",
  initialCursor: props.cursor,
  subscribe: (cursor) => ({
    type: "subscribe",
    payload: { itemId: props.itemId, fromCursor: cursor },
  }),
  parse: (raw) => InventoryEventSchema.parse(JSON.parse(raw)),
  onMessage: (event, controls) => {
    void inventory.invalidate({ cursor: event.cursor })
      .then(() => controls.markApplied(event.cursor))
      .catch(() => {
        // Reconnect replays from the last applied cursor.
      });
  },
  onFatal: (error) => setLiveError(error.message),
});

onMount(() => live.connect());
onCleanup(() => live.dispose());
```

The helper owns one socket, visibility-aware activity, reconnect backoff,
connection deadlines, recovery when the tab or network returns, cursor resume,
fatal close classification, and disposal.

The application owns authentication, subscription payloads, runtime
validation, permissions, and domain updates.

When one application has two current realtime concerns, keep one physical
socket and use typed logical channels. `onOpen` can send the additional current
subscription through `controls.send()`, and the returned connection exposes the
same `send()` operation for later subscribe or unsubscribe messages. Keep each
channel's recovery state independent: a durable invalidation cursor must not be
advanced by unrelated ephemeral stream events.

## Recover after interruptions

With the default `activity: "visible"`, a hidden tab closes its socket and
reports `paused`. With `activity: "always"`, the socket stays open while the
tab is hidden.

A handshake that has not opened after 10 seconds is closed and retried with
backoff. When the tab becomes visible or the window regains focus, a stalled
handshake or a pending backoff is replaced by an immediate attempt. When the
browser reports `online`, a handshake still in progress is replaced too,
because it started on the network that was gone. In both cases the backoff
starts over. An open socket is left alone. Each new socket resubscribes from
the last applied cursor, and `onOpen` runs again.

Terminal closes and `dispose()` end recovery. Neither reconnects.

## Advance only after coverage

For a server-backed snapshot, call `markApplied()` only after the matching
query invalidation has committed a covering snapshot. If one event affects
several queries, wait for all matching invalidations.

Apply an event directly only when it contains the complete authoritative
projection. If apply or invalidation fails, do not advance. A reconnect can
replay the event from the last known good cursor.

When the server reports cursor overflow or the local state cannot reconcile,
reload the authorized snapshot.

See [Server-backed state](/en/docs/frontend/server-backed-island-state) for the
query invalidation contract.

## Handle access changes

The WebSocket route must authorize the subscription and every resource it
streams.

Close code `1008` is terminal by default and surfaces an access error. Do not
keep reconnecting after permission is lost.

Close codes `1011` and `1013` are also terminal by default. Return `null` from
a custom `classifyClose` handler only when the application can safely
reconnect.

On the server, close with `1012` when a lookup throws because infrastructure
is briefly unavailable, for example the stream cursor or the session store.
The client reconnects with backoff, and the new subscription checks access
again. Keep `1008` for access decisions.

## Preserve reload behavior

The gateway reports abnormal upstream disconnects and failed upstream connection
attempts as `1012`, so the live client retries during an application restart.
Explicit application close codes, including terminal `1011`, are preserved.

The URL must still identify the visible resource and view. A reload asks the
server for a fresh authorized result.

Reload automatically, from a live event, a terminal close, or a failed
invalidation, only through `reloadOnce(key)` from `@k2b/cloud/browser/reload`.
It reloads at most once per key within 30 seconds in the tab, so a condition
that persists after the reload cannot reload the page in a loop. When it
returns `false`, keep the page usable and offer a reload button instead:

```ts
import { reloadOnce } from "@k2b/cloud/browser/reload";

onFatal: () => {
  if (!reloadOnce(`tasks:live:${boardId}`)) setLiveUnavailable(true);
},
```

`reloadOnce` also returns `false` when `sessionStorage` is unavailable. A
reload that follows an explicit user action does not need the guard.

Do not keep the only copy of edits or selected resources in the socket client.

For server event semantics, see
[Topics and live events](/en/docs/automation/topics-and-live-events).
