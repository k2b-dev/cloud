---
title: URL state and navigation
navTitle: URL state and navigation
section: Frontend
order: 860
description: Keep durable view state in the URL and navigate without losing server authority.
tags: [url, navigation, filters]
updated: 2026-08-10
---

# URL state and navigation

Put reloadable view state in the URL.

Filters, sorting, pagination, selected resources, active tabs, and date ranges
must survive reload, sharing, and Back or Forward navigation.

## Parse server filters

```ts
import {
  createUrlFilter,
  oneOf,
  page,
  text,
} from "@k2b/cloud/ssr";

const inventoryFilter = createUrlFilter("/app/inventory", {
  search: text("search"),
  status: oneOf("status", ["all", "low", "out"] as const, "all"),
  page: page(),
});

const state = inventoryFilter.parse(new URL(c.req.url));
const nextHref = inventoryFilter.build(state, {
  status: "low",
  page: 1,
});
```

The filter defines parsing and link generation in one place. Build links from
the current state so one control does not erase unrelated filters.

Query state still needs service validation before it reaches SQL.

See [Pagination and filtering](/en/docs/server/pagination-and-filtering) for
the server-side query.

## Use links first

Use anchors for navigation. Tables, pagination, range controls, and filter
chips should work without JavaScript.

An island can use `@k2b/ssr/nav` when it can update the visible state
without a full document render:

```tsx
import {
  Link,
  listenPopState,
} from "@k2b/ssr/nav";
import { onCleanup, onMount } from "solid-js";

onMount(() => {
  onCleanup(
    listenPopState(({ url }) => {
      setSelected(url.searchParams.get("item"));
    }),
  );
});
```

Call `push()` or `replaceWith()` only after the island has loaded or applied the
new state.

For server-backed state, set the query source first and commit history only
after data for that source applies. If the target load fails, restore the last
committed source so a later refresh or live invalidation cannot apply data for
a URL the browser never entered. See
[Server-backed state](/en/docs/frontend/server-backed-island-state).

Subscribe to `popstate` whenever an island changes history. Otherwise the URL
and visible state diverge after Back or Forward.

The navigation helper is not a client router. It does not run server loaders or
re-render server components. Fall back to document navigation when the server
must produce a new result set.

## Transient UI state

Hover, focus, open menus, unsaved field input, and temporary panel animation do
not belong in the URL.

Persist workspace geometry only through the shared shell when the product
needs it. Do not add app-specific cookies for shared layout behavior.
