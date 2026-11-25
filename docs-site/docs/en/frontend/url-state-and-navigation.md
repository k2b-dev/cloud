---
title: URL state and navigation
navTitle: URL state and navigation
section: Frontend
order: 860
description: Keep durable view state in the URL and navigate without losing server authority.
tags: [url, navigation, filters]
updated: 2026-11-25
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

## Declare a v2 list query

A list built with `@k2b/ui/v2` declares its filters, sorts, and groups with
`defineListQuery` from `@k2b/ui/v2/list-query`. This entry is pure TypeScript
without DOM access or Solid, so the page loader and the island import the same
declaration. Every field, value, sort, and group is declared. Labels are the
application's final strings; keys and values are stable codes in the URL.

```ts
import { defineListQuery, field } from "@k2b/ui/v2/list-query";

export const articleQuery = defineListQuery({
  key: "articles",
  fields: {
    status: field.choice({ label: t("Status"), options: STATUS_OPTIONS, common: true }),
    price: field.numberRange({ label: t("Price"), unit: "€" }),
    consignor: field.lookup({ label: t("Consignor"), load: searchConsignors, resolve: consignorNames }),
    received: field.dateRange({
      label: t("Received"),
      presets: [{ value: "last-30d", label: t("Last 30 days") }],
    }),
  },
  search: { label: t("Number or title") },
  sort: {
    options: { received: { label: t("Received") }, price: { label: t("Price") } },
    default: { field: "received", direction: "desc" },
  },
  group: { status: { label: t("Status") } },
  pageParams: ["selected"],
});

const { state, issues } = articleQuery.parse(new URL(c.req.url).searchParams);
// state.filters.status: readonly ("consigned" | "sold" | …)[] | undefined
// undefined when the URL cannot hold the follow-up state: show no link then.
const next = articleQuery.set(state, "price", { min: 500 });
const href = next && `?${articleQuery.serialize(next)}`;
```

The field kinds are `choice` (declared values, many or with `multiple: false`
one), `lookup` (values loaded with `load(query, { signal, limit })`, named
with `resolve(ids, { signal })` during server rendering), `numberRange`,
`dateRange` (calendar days), `timeRange` (UTC minutes), `bool`, and `text`.
Both date kinds take presets, and every range may leave one end open:
`price=500..`, `received=..2026-11-30`. `required: <value>` makes a field
mandatory, such as the time range of a log: it is always active and returns
to that value when cleared. A list with one fixed order declares
`sort: { fixed: { field, direction, label } }` and has no `sort` parameter.

- `parse` never throws for URL input. It drops invalid, unknown, duplicate,
  and too long parts and lists them in `issues` with a stable `code`
  (`invalid`, `unknown`, `duplicate`, `too_long`); the page words them.
  Parameters named in `pageParams` and those starting with `_` are not
  reported.
- `serialize` writes `view`, the fields in declaration order, `q`, `sort`,
  and `group`, and omits defaults, so equal states give equal URLs. Pass the
  current parameters as `base` to keep the page's own ones. Whatever it
  writes, `parse` reads back to the same state.
- `set` is the one way to a follow-up state: it changes one filter, the
  search (`"q"`), the `"sort"`, or the `"group"`. It never throws and
  returns `undefined` when the value is not valid or the URL cannot hold the
  result, such as a query longer than `LIST_QUERY_MAX_LENGTH` (2,000
  characters). Offer no link or action then. `clear` and `reset` always fit.
- `serialize` throws a `RangeError` only for a state built by hand that the
  URL cannot hold; states from `parse`, `set`, `clear`, and `reset` always fit.

**The application filters and stores views itself.** `@k2b/ui` neither
filters nor stores. The page loader turns the parsed state into its own SQL
with its own access checks, counts what it shows, and resolves lookup names.
Saved views are `{ key, label, query }`, where `query` is the serialized
state. The `ViewStore` type describes a store; the application implements it
in a cookie, in its own table per person or for everyone, or not at all, and
its server checks every write.

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
  for a file download without `download`. Mark every in-scope link to a
  non-HTML resource this way or with `download`: otherwise the swap fetch
  learns the type first, and the server receives the request twice. Keep
  this in mind for single-use links.

An island outside the column installs the swap once:

```tsx
import { installPageSwap } from "@k2b/ssr/nav";
import { onCleanup, onMount } from "solid-js";

onMount(() => onCleanup(installPageSwap()));
```

In a swap host, the loader imports modules that are used only outside the
column first. Modules with an instance in the column load after them, also
for their instances outside it, because importing a module mounts every
instance. An installer outside the column therefore precedes column islands
that write history. Use the installer island only outside the column.
`listenPopState()` remains safe in either installation order.

A click that an island handler prevented is never swapped. Modifier keys,
`target`, `download`, `rel="external"`, other origins, links outside the
scope, and hash links on the same page stay native. `swapPage(href, {
replace })` starts a swap from code. To show the current page again after a
change, pass `{ replace: true, scroll: "preserve" }`: the window and keyed
regions keep their scroll position instead of starting at the top.

The swap fetches the page and loads its island modules before it changes the
old column. Then it disposes the old islands, pushes history, replaces the
column, sets the title, mounts the new islands, focuses the first visible heading of
the column, and announces the title. A newer navigation cancels a pending
swap, also a native form submission, an island's `Link` click, or a
`navigate()` call. A swap that starts while a `Link` handler still loads
wins as well: that handler's `push`, `replaceWith`, and `fallback` then do
nothing. Island cleanups should not navigate: they run inside the swap.

Any failure loads the requested URL as a document, so the person sees what a
reload shows: a failed request, a status other than 200 such as an expired
session's 403, a response that is not HTML, a redirect out of the scope, a
different signature, another `<base>`, `lang` or `dir` on `<html>`, a new build
with another module prefix or other stylesheets, or a module that fails. The
old column stays untouched until then; there is no half-swapped page. Inline
scripts in the fetched page do not run; give page data to islands as props.

`installPageSwap({ timeout })` bounds the fetch and module loading in
milliseconds. Past it, the swap gives up and loads the document, so a hanging
request never leaves the old page pending. Without `timeout` there is no
limit.

Right before such a document load, `window` receives `ssr:nav-fallback` with
`detail: { reason, url, status? }`. `reason` is a stable code: `network`,
`timeout`, `status`, `content-type`, `redirect`, `shell`, `assets`, `head`,
`module`, `commit`, `history`, `history-limit`, or `error`; `status` names a non-200 response.
Hosts count it to find pages that keep falling back. `url` is the requested URL;
strip it before reporting. Links outside the scope are not failures and emit
nothing.

A swap keeps the document's `<head>`. It takes the fetched page's title and
`<meta name="description">`. It compares only `<base>`, the stylesheet links,
and `lang` and `dir` on `<html>`; a difference there loads the document. Put
every other head difference, such as inline styles, the viewport, or a
canonical link, into the shell signature. Cloud does that for its layouts.

Back and Forward fetch another server page's column without a document load.
Within the shown page, `listenPopState()` lets islands restore state from the
URL without fetching. It never reports a traversal to another server page.
Nav restores window scroll and keyed `data-scroll-preserve` regions from the
arriving entry once, right after its islands mount; within a page, islands
still own region scroll. An asynchronous same-page replacement can ask nav to
[restore the saved position after its DOM commit](#restore-a-list-after-an-asynchronous-history-commit).
Cross-page islands that load content after mounting still manage that later
rendering themselves. A traversal that cannot swap reloads the arriving URL.

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

Opt in with `defineApp({ pageSwap: true, ... })`. The default is off. A list
of paths, such as `pageSwap: ["/app/inventory/:itemId/history"]`, limits swaps
to pages under one of them and to links within the matched path; see
[Define an app](/en/docs/build/define-app#keep-the-shell-during-page-navigation).
Before you opt in, move every `beforeunload` guard of the swapped pages to
[`protectUnsavedInput()`](#protect-unsaved-input) and give the app the
browser tests described in [Swap stability](#swap-stability).
Cloud keeps the rail, panel slot, and provider document. Links in the app menu
behind the page title on phones swap like links in the column.
It replaces the header, banners, warnings, page trail, main content, footer,
and the page's shell data and Help ids. Regular and full-page layouts can
swap between each other.

Back and Forward restore the page scroller; a link opens the next page at the
top, or at its hash target. When a swap takes longer than 200 ms, a thin bar at the top of
the window shows that the page is changing; the old content stays until the
new page arrives.

The panel follows the arriving page's consent answer, and the rail and phone
tab bar follow its rail preferences.

`focusMode` pages and links outside the current app route prefix load a
document. So does a page whose kept shell would differ from a reload: another
user, session kind, locale, theme preference, page theme, or build, other panel providers,
navigation entries, legal or search links, or profile, a new announcement, or
other Help. Every swap fetch passes through the same server route policies as a
reload.

Column islands use `listenPopState()` and `navigate()` for their own URL state.
The loader mounts the shell islands that are used only outside the column
first, so Cloud installs page swaps before column islands write history.
`listenPopState()` is safe regardless of installation order and reports only
same-page traversals. Shell code follows `ssr:nav-popstate` for cross-page
traversals and `ssr:nav-swapped` for the committed content.

Web Vitals belong to the document. INP and CLS cover every swapped page and
carry the route template of the page that loaded the document.

Protect unsaved column state with `protectUnsavedInput()` as described below.
`beforeunload` is not consulted during swaps.

Cloud bounds each swap by the gateway's idle timeout of 10 seconds. A page
that takes longer loads as a document instead. Each fallback of a signed-in
person is recorded once in the `page-swap` log with the app and the reason,
without path, query or person (see [Observability](/en/docs/operations/observability#page-swap-fallbacks)).

### Swap stability

A swap must never leave a page that a reload would not show. Cloud holds
page swaps to this contract; the framework tests in `packages/ssr/test/engine`
and each app's swap tests check it in Chromium and WebKit:

- **Fallback:** a failed request, a timeout, any status other than 200 (an
  expired session included), another build or asset version, another shell,
  a changed head, a failing island module, and a commit or history conflict
  each load the requested URL once as a document. The old column stays until
  then. Each fallback is reported with its reason.
- **History:** Back and Forward swap the arriving page and restore its scroll;
  a new page opens at the top or its hash. Focus moves to the first visible heading,
  and the title is announced to screen readers.
- **Head:** title and description follow the page. Language, theme, user,
  build and app are part of the shell signature, so a change of any of them
  loads the document, and with it the right `lang`, head and accent color.
- **Cleanup:** the old column's islands are disposed before the new ones mount,
  so their `onCleanup` stops timers, sockets, listeners and live
  subscriptions. 50 swaps leave window and document listeners, the head and
  the shell at their size after the first. Shell islands outside the column,
  such as the rail, the panel and toasts, keep their state.
- **Live updates:** `liveConnection()` shares one socket per page and closes
  it when the last subscription closes; a swap subscribes once per mounted
  island.
- **Unsaved input:** `protectUnsavedInput()` asks before a swap and the
  browser asks before a document load, as before page swaps.
- **Access:** every swap fetch passes the same route policy and SSR permission
  checks as a reload, and the column is the server's HTML for that URL.
- **Other apps:** links outside the app's route prefix stay document loads.

## Protect unsaved input

For a draft or form, call `protectUnsavedInput()` while the island renders. It
asks your dialog before a page swap leaves and lets the browser ask before a
document load, such as a reload, a closed tab, or a link to another app:

```tsx
import { protectUnsavedInput } from "@k2b/ssr/nav";

protectUnsavedInput({
  dirty: () => form.dirty(),
  confirm: () => prompts.confirm(t().discardChanges, { variant: "danger" }),
});
```

`confirm` may return a promise. Once the person confirms, the island does not
ask again on its way out, also when the swap falls back to a document load.
Declining keeps the page, its input and, for Back or Forward, its history
entry.

For your own decision logic, call `onBeforeLeave()` while an island renders or in `onMount` to protect
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


## Restore a list after an asynchronous history commit

With page swaps enabled, the shared navigation owner keeps each history entry's
window and keyed `data-scroll-preserve` positions. If a `listenPopState()` handler
replaces a list asynchronously, call `deferScrollRestore()` during the handler,
then invoke its returned completion immediately after committing the new DOM:

```tsx
onCleanup(listenPopState(({ url, deferScrollRestore }) => {
  const restore = deferScrollRestore();
  void replaceList(url).then((committed) => { if (committed) restore(); });
}));
```

Here `replaceList` is application code: it must abort or ignore stale responses
and resolve after its DOM commit. Nav keeps the entry's saved position while it
loads and restores it once after that commit. A newer navigation, uninstall, or
user input cancels the replay. Always complete an applied DOM commit, even after
user input cancelled its replay, so subsequent captures observe the new list.
Keep the shared history owner; do not add a separate application scroll map for
this case. Without an installed page swap, the completion does nothing.
