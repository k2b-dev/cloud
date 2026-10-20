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
Every application can use the generic `@k2b/ssr/nav` contract. Cloud provides
the opt-in integration described below.

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

In a swap host, the loader mounts islands outside the column first, so an
installer outside the column precedes column islands that write history;
`listenPopState()` remains safe in either installation order.

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
arriving entry once, right after its islands mount; within a page, islands
still own region scroll. An island that loads its content later keeps its
own position, for example in its history state, and restores it after loading. A traversal that cannot swap reloads the arriving
URL.

Add `data-scroll-page` to a keyed region to restore it on Back/Forward and
reload recovery while starting push and replace swaps at the top or hash
target, without copying the departing page's position.

For a traversal that proceeds to a swap, nav dispatches `ssr:nav-popstate` on
`window` with the `PopStateEvent` as `detail`, for code that keeps its own history
bookkeeping, such as `@k2b/ui` dialogs. Shell code outside the swapped
column, such as a panel or a rail, misses cross-page traversals through
`popstate` and `listenPopState()` as well; it follows them through
`ssr:nav-popstate`. Install before islands register raw `popstate` listeners. Prefer
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

After each committed swap, `window` receives `ssr:nav-swapped` with
`detail: { root }`, where `root` is the inserted column. It fires once after
islands mount, scroll restores, focus moves, and the title is announced.
This includes pushes, replaces, Back, and Forward. Document loads and failed
swaps emit no event. A listener error does not trigger a document load.

## Cloud page swaps

Opt in with `defineApp({ pageSwap: true, ... })`. The default is off.
Cloud keeps the rail, phone tab bar, panel slot, and provider document.
It replaces the header, banners, warnings, page trail, main content, footer,
and the page's shell data and Help ids. Regular and full-page layouts can
swap between each other.

Back and Forward restore the page scroller; a link opens the next page at the
top, or at its hash target.

The panel follows the arriving page's consent answer, and the rail and phone
tab bar follow its rail preferences.

`focusMode` pages and links outside the current app route prefix load a
document. So does a page whose kept shell would differ from a reload: another
user, session kind, locale, theme preference, page theme, or build, other panel providers,
navigation entries, legal or search links, or profile, a new announcement, or
other Help. Every swap fetch passes through the same server route policies as a
reload.

Column islands use `listenPopState()` and `navigate()` for their own URL state.
The loader mounts the shell islands outside the column first, so Cloud installs
page swaps before column islands write history.
`listenPopState()` is safe regardless of installation order and reports only
same-page traversals. Shell code follows `ssr:nav-popstate` for cross-page
traversals and `ssr:nav-swapped` for the committed content.

Protect unsaved column state with `onBeforeLeave()` as described below.
`beforeunload` is not consulted during swaps; keep it for document loads.

## Protect unsaved input

Call `onBeforeLeave()` while an island renders or in `onMount` to protect
unsaved input before an in-scope link click, `swapPage()`, or a Back/Forward
swap leaves its page:

```tsx
import { createSignal } from "solid-js";
import { onBeforeLeave } from "@k2b/ssr/nav";

export default function Draft() {
  const [dirty, setDirty] = createSignal(false);
  onBeforeLeave((event) => {
    if (dirty() && !window.confirm("Discard unsaved changes?")) {
      event.preventDefault();
    }
  });
  return <form onInput={() => setDirty(true)}><textarea aria-label="Draft" /></form>;
}
```

The check ends with its Solid owner; the returned function also removes it.
Only islands inside the current `data-nav-root` column are asked. Shell and
rail islands stay mounted and are not asked. Without an owner, or with an
owner outside an island, the check applies to every swap until disposed.
Registration does nothing on the server.

Checks run synchronously in registration order. Each gets its own event with
an absolute `url` and, for Back/Forward, a signed `delta` (negative for Back).
The first `preventDefault()` wins; later checks are not asked. A check that
throws allows navigation and reports the error through `reportError()`, even
if it prevented before throwing. Return values and promises are ignored.

For your own async dialog, veto first and wait for `event.restored` before
opening it. After confirmation, clear the dirty state and retry the navigation.
Replace the check above with this one; `askToDiscardChanges()` is your dialog:

```tsx
import { onBeforeLeave, swapPage } from "@k2b/ssr/nav";

onBeforeLeave((event) => {
  if (!dirty()) return;
  event.preventDefault();
  void event.restored
    .then(() => askToDiscardChanges())
    .then((confirmed) => {
      if (!confirmed) return;
      setDirty(false);
      // A history-backed dialog replaced the forward entries: only Back can traverse again.
      if (event.delta !== undefined && event.delta < 0) history.go(event.delta);
      else void swapPage(event.url.href);
    });
});
```

`event.restored` resolves when history is back on this page's entry: right away
for a vetoed click or `swapPage()`, after rollback for Back/Forward; it never
rejects and stays pending if nobody vetoes.

A check must not write history itself: open history-backed dialogs after
`event.restored`; if a check writes history during Back/Forward, nav loads the
document.

A vetoed click or `swapPage()` leaves the URL, history, column, and any older
pending swap untouched. A vetoed Back/Forward aborts a pending swap and rolls
history back to the shown entry. Nav absorbs the vetoed and rollback
popstates: `listenPopState()`, raw listeners registered after nav, and
`ssr:nav-popstate` see no navigation. Popstate and Navigation API listeners
registered before nav, such as `@k2b/ui` dialog-core, still see both; a
multi-step vetoed Back past an open history dialog therefore closes that
dialog. While rollback is pending, all further popstates are absorbed without
more checks. Nav uses an absolute
`navigation.traverseTo()` target when the departure key is available, otherwise
`history.go()` using marker positions.
A failed rollback reloads, unless a newer swap committed meanwhile.
With relative rollback, a rapid second traversal can force a reload.
If the traversal delta is unknown or zero, nav cannot roll back and asks no
checks.

Document loads never ask: native links, `data-nav-document`, out-of-scope
URLs, missing shells, `navigateTo()`, `documentNavigate()`, and
`refreshCurrentPath()`. Island-owned `Link` navigation with `onNavigate`,
`navigate()`, raw history writes, and same-page popstates are not swaps.
bfcache `pageshow` swaps, further traversals during a pending cross-page
traversal, and fragment claims that continue one do not ask again.

Nav does not run or consult `beforeunload` handlers during a swap: there is
no API to ask them, and a synthetic event shows no dialog. `onBeforeLeave` is
the contract for swaps. Keep `beforeunload` for document loads, such as a
reload, a closed tab, a link outside the scope, or a swap that fails after the
checks allowed it and loads the document.

## Transient UI state

Hover, focus, open menus, unsaved field input, and temporary panel animation do
not belong in the URL.

Persist workspace geometry only through the shared shell when the product
needs it. Do not add app-specific cookies for shared layout behavior.
