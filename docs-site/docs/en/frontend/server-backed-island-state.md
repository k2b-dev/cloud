---
title: Keep server-backed island state current
navTitle: Server-backed state
section: Frontend
order: 855
description: Keep an authorized SSR snapshot current with owner-local Solid queries, pagination, mutations, and live invalidation.
tags: [frontend, solidjs, queries, state]
updated: 2026-08-10
---

# Keep server-backed island state current

Start an interactive result set with the authorized snapshot rendered by the
server. Use an owner-local `query.create()` inside the island to load the same
view again when its URL source changes, a user refreshes it, a mutation
completes, or a live event invalidates it.

This keeps one canonical read path:

1. the SSR handler loads and authorizes the initial snapshot;
2. the island receives that snapshot and its exact source as serializable
   props;
3. a typed browser loader reloads the same view;
4. mutations and live events invalidate that query instead of maintaining a
   second client-side domain model.

`query` is an owner-local state controller, not a global cache or a replacement
for application APIs. The application still owns authorization, loaders, URL
semantics, live transport, and how pages are projected into the UI.

## Create the canonical read

Call `query.create()` inside a Solid component or reactive owner:

```tsx
import { query } from "@k2b/stdlib/solid";
import { createSignal, Show } from "solid-js";
import { inventoryApi } from "./api.client";

type Item = { id: string; name: string };

export default function ItemWorkspace(props: {
  item: Item;
}) {
  const [itemId, setItemId] = createSignal(props.item.id);

  const item = query.create<string, Item>({
    source: itemId,
    initial: { source: props.item.id, data: props.item },
    load: async (id, { abortSignal }) => {
      const response = await inventoryApi.items[":id"].$get(
        { param: { id } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error("Item could not be loaded.");
      return response.json();
    },
  });

  const currentItem = () =>
    item.data()?.id === itemId() ? item.data() : undefined;

  return (
    <Show when={currentItem()} fallback={<p>Loading item…</p>}>
      {(current) => <h1>{current().name}</h1>}
    </Show>
  );
}
```

Use the typed Hono client described in
[Browser clients and mutations](/en/docs/frontend/browser-clients-and-mutations)
instead of raw `fetch()` when the application exposes a typed JSON route.

The `initial` source must match the query's current source according to its
source comparator. A matching snapshot suppresses the hydration request.
Without one, the first load starts after the island mounts. Loads and
subscriptions never start during server rendering.

Each query belongs to the Solid owner that creates it. Equal sources in two
owners do not share data, requests, persistence, or invalidation.

## Render only data for the current source

When a source changes, the query aborts the old request and preserves the
last-good data until the new source commits. This avoids blanking a useful view,
but the old data must not be presented as the new resource.

For resource identity or search results, include the source in the loaded
result and guard the rendered projection:

```tsx
type SearchResult = {
  source: string;
  items: Item[];
};

const results = query.create<string, SearchResult>({
  source: searchUrl,
  initial: {
    source: props.searchUrl,
    data: { source: props.searchUrl, items: props.items },
  },
  load: async (source, { abortSignal }) => ({
    source,
    items: await loadItems(source, abortSignal),
  }),
});

const currentItems = () =>
  results.data()?.source === searchUrl() ? results.data()!.items : [];
```

Use the query states deliberately:

- `loading()` means no snapshot is available for the request;
- `refreshing()` means last-good data remains visible while a canonical load
  runs;
- `stale()` means visible data is not yet confirmed for the current source or
  invalidation;
- `error()` reports the latest failed load.

Existing data does not make a refresh error irrelevant. Show a visible retry
or warning when stale data remains, especially before a revision-sensitive
write.

## Refresh and invalidate for different reasons

Use `refresh()` for an explicit reload. It resolves when that attempt settles;
read failure details from `error()`.

Use `invalidate(meta)` when an external action requires a snapshot that began
after that action. Its Promise resolves only after a covering snapshot commits.
If an invalidation arrives during request A, the query starts a follow-up
request B before resolving it.

The invalidation Promise rejects when its covering load fails, the source
changes, the query is aborted, or its owner is disposed. This stronger contract
makes it suitable for live cursor acknowledgement.

## Reconcile writes without changing their outcome

Use `mutation.create()` for user-initiated writes and commands. Capture the
complete intent in mutation variables or one-time context: selected resources,
destination, payload, idempotency key, and correlation ID. `retry()` reuses the
same variables and context and does not run `onBefore` again.

After a successful write, update from the returned canonical resource or
invalidate the affected query. Mutation lifecycle hooks are synchronous and
are not awaited. Do not put required asynchronous reconciliation in an async
`onSuccess` hook.

A durable write and its follow-up read are separate outcomes. If the write
succeeds but invalidation fails, report that the change was saved and the view
could not be refreshed. Do not present the write as failed or retry a completed
non-idempotent command.

See [Forms, prompts, and feedback](/en/docs/frontend/forms-prompts-and-feedback)
for presenting these states.

## Load additional pages

Use `query.createInfinite()` when the island owns an incrementally loaded
result set:

```tsx
type Page = { items: Item[]; nextCursor: string | null };

const items = query.createInfinite<string, Page, string>({
  source: requestUrl,
  initial: { source: props.requestUrl, pages: [props.firstPage] },
  loadPage: (source, { cursor, abortSignal }) =>
    loadPage(source, cursor, abortSignal),
  getNextCursor: (page) => page.nextCursor,
});
```

The query keeps pages intact. The island flattens and deduplicates items,
renders the load-more control or viewport observer, and rejects a repeated next
cursor to prevent a pagination loop.

Concurrent `loadMore()` calls share one request. Refresh and invalidation
supersede load-more and atomically rebuild the number of pages already loaded.
`loadMore()` exposes failures through `error()`; it does not provide the
coverage guarantee of `invalidate()`.

Keep pagination cursors separate from opaque live-event cursors. The server
owns cursor validation and result limits; see
[Pagination and filtering](/en/docs/server/pagination-and-filtering).

## Connect live invalidation

Live transport tells the query that its authorized snapshot is stale. For an
event that does not contain a complete authoritative projection, invalidate
the affected query and acknowledge the cursor only after coverage:

```tsx
import { createLiveWebSocket } from "@k2b/cloud/browser/live";

subscribe: ({ invalidate }) => {
  const live = createLiveWebSocket<InventoryEvent>({
    url: "/api/inventory/ws",
    subscribe: (cursor) => ({ type: "subscribe", cursor }),
    parse: (raw) => InventoryEventSchema.parse(JSON.parse(raw)),
    onMessage: (event, controls) => {
      void invalidate({ cursor: event.cursor })
        .then(() => controls.markApplied(event.cursor))
        .catch(() => {
          // The transport owns replay and retry policy.
        });
    },
  });
  live.connect();
  return () => live.dispose();
},
```

When one cursor affects several queries, the application coordinates all
matching invalidations and acknowledges only after all covering Promises
resolve. Directly applying an event is appropriate only when the event itself
is the complete authoritative projection.

`query.subscribe` is owner-scoped and cleanup-aware, but transport-neutral.
The application still owns WebSocket authentication, validation, reconnect,
backoff, replay, and fan-out. See [Realtime UI](/en/docs/frontend/realtime-ui).

## Keep navigation reloadable

Use the URL as the query source for reloadable filters, selection, and views.
For enhanced navigation, change the query source, wait until a matching
snapshot commits, and only then call `push()` or `replaceWith()`. Restore the
last committed source when loading the target fails.

Keep the anchor `href` as the document-navigation fallback and handle Back and
Forward through `popstate`. See
[URL state and navigation](/en/docs/frontend/url-state-and-navigation).
