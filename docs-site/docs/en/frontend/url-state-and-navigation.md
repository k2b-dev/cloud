---
title: URL state and navigation
navTitle: URL state and navigation
section: Frontend
order: 860
description: Keep durable view state in the URL and navigate without losing server authority.
tags: [url, navigation, filters]
updated: 2026-10-20
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

## Search server-rendered lists

Use the shared `SearchBar` for a list whose results come from its page loader:

```tsx
import { SearchBar } from "@k2b/cloud/ssr/islands";

<SearchBar
  action={inventoryFilter.build(state)}
  value={state.search}
  placeholder="Search inventory…"
  ariaLabel="Search inventory"
/>;
```

`action` is required. Include every query parameter the search should retain.
The component submits a native GET form and clears through a normal link, so
both actions work directly in server HTML and inside an existing island.
It needs no separate island wrapper. Submission navigates to a fresh server
result; it does not issue a request on every keystroke.

By default, the input replaces `search` and resets `page`. Use `param` and
`pageParam` for other names, including cursor pagination. Other parameters,
including repeated values and other searches on the page, become hidden form
fields. Clearing removes only this search and its pagination parameter.

`value` defaults to the search in `action`. Parse and trim submitted text on
the server, for example with `text()` above; an empty GET input is sent as an
empty string. Labels inherit the UI locale unless explicitly supplied.
Pass `disabled` when surrounding work must block both searching and clearing;
this also applies when placing the component inside a disabled `<fieldset>`.

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

Use `listenPopState()` whenever an island changes history. Otherwise the URL
and visible state diverge after Back or Forward.

The navigation helper has no route matching and no client loaders. When the
server must produce the next result, use a normal link: a document load, or a
page swap where the host installed one.

## Swap server-rendered pages

A page swap keeps the document and replaces only the content column with the
next server page. A navigation rail or an open side panel stays as it is.
Every application can use it; it is part of `@k2b/ssr/nav`, not of Cloud.

The server page declares the parts:

```html
<div
  data-nav-shell="inventory:user-42:en:standard:3f9a"
  data-nav-scope="/app/inventory"
  data-nav-attributes="data-mode"
>
  <nav><a href="/app/inventory/low">Low stock</a></nav>
  <main data-nav-root><h1>Inventory</h1></main>
</div>
```

- `data-nav-shell` is a signature that nav compares and does not read. Put
  everything into it that must be equal for a swap: the application, the
  user, the locale, the layout kind, and the build.
- `data-nav-scope` is the path prefix of links that swap. `/app/inventory`
  takes `/app/inventory/low`, not `/app/inventory-old`.
- `data-nav-root` is the column. The fetched page's column replaces it.
- `data-nav-attributes` names shell attributes that the fetched page sets or
  removes, for example a layout mode.
- `data-nav-document` on a link keeps its document navigation, for example
  for a file download without `download`.

An island outside the column installs the swap once:

```tsx
import { installPageSwap } from "@k2b/ssr/nav";
import { onCleanup, onMount } from "solid-js";

onMount(() => onCleanup(installPageSwap()));
```

A click that an island handler prevented is never swapped. Modifier keys,
`target`, `download`, `rel="external"`, other origins, links outside the
scope, and hash links on the same page stay native. `swapPage(href, {
replace })` starts a swap from code.

The swap fetches the page and loads its island modules before it changes the
old column. Then it disposes the old islands, pushes history, replaces the
column, sets the title, mounts the new islands, focuses the first heading of
the column, and announces the title. A newer navigation cancels a pending
swap, also a native form submission, an island's `Link` click, or a
`navigate()` call. A swap that starts while a `Link` handler still loads
wins as well: that handler's `push`, `replaceWith`, and `fallback` then do
nothing. Island cleanups should not navigate: they run inside the swap.

Any failure loads the requested URL as a document, so the person sees what a
reload shows: a status other than 200 such as an expired session's 403, a
response that is not HTML, a redirect out of the scope, a different
signature, another `<base>`, a new build with another module prefix or other
stylesheets, or a module that fails. Inline scripts in the fetched page do not
run; give page data to islands as props.

Back and Forward fetch another server page's column without a document load.
Within the shown page, `listenPopState()` lets islands restore state from the
URL without fetching. It never reports a traversal to another server page.
Nav restores window scroll and keyed `data-scroll-preserve` regions from the
arriving entry; within a page, islands still own region scroll. A traversal
that cannot swap reloads the arriving URL.

Install before islands register raw `popstate` listeners. Prefer
`listenPopState()`, which is safe in either order. Keep history state a plain
object or `null`: nav preserves its fields and reserves `"@k2b/ssr/nav"` for
`{ page, position, scroll? }`. Other state values stay unchanged and unmarked;
returning to them fetches the server page or reloads the document.

While installed, nav sets `history.scrollRestoration` to `"manual"`. Uninstall
restores the previous value for the current entry only; entries created while
installed stay manual. The history wrappers stay installed but become
inert. Reloads retain page identity and scroll snapshots for up to 50 entries;
`"@k2b/ssr/nav:scroll"` is reserved in sessionStorage. bfcache returns check the
arriving entry. Dialog-only traversals remain with the dialog history owner.

A swap does not fire `beforeunload`; an island with unsaved input must prevent
in-scope link clicks itself (for example, a document capture listener calling
`preventDefault()`, which the swap honours) or mark the links with
`data-nav-document`.

## Transient UI state

Hover, focus, open menus, unsaved field input, and temporary panel animation do
not belong in the URL.

Persist workspace geometry only through the shared shell when the product
needs it. Do not add app-specific cookies for shared layout behavior.
