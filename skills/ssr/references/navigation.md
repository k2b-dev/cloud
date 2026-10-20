# Optional `@k2b/ssr/nav`

Use `@k2b/ssr/nav` only when an island/client component needs progressive same-origin navigation without a document reload.

```tsx
import { onCleanup, onMount } from "solid-js";
import { Link, listenPopState, type LinkNavigateEvent } from "@k2b/ssr/nav";

onMount(() => {
  onCleanup(
    listenPopState(({ url }) => {
      setTab(url.searchParams.get("tab") ?? "alpha");
    }),
  );
});

const openTab = (nav: LinkNavigateEvent) => {
  const tab = nav.url.searchParams.get("tab") ?? "alpha";
  setTab(tab);
  nav.push(`/demo?tab=${tab}`, { scroll: "preserve", state: { tab } });
};

<Link href="/demo?tab=beta" scroll="preserve" onNavigate={openTab}>
  Open beta
</Link>;
```

Rules:

- `Link` is a real SSR-safe `<a href>` and works without JavaScript as a normal link
- nav has no route matching and no client loaders; it can swap server-rendered pages when the host opts in (below)
- without `onNavigate`, `Link` keeps native document navigation, or a page swap when one is installed; `replace` and `scroll` only apply to enhanced clicks
- with `onNavigate`, update island state or load data first, then call `nav.push()`, `nav.replaceWith()`, or `nav.fallback()`
- when using `nav.push()`, subscribe with `listenPopState()` and restore island state from the URL on Back/Forward
- rejected async `onNavigate` callbacks fall back to full document navigation
- same-document hash links retain native scrolling unless `onNavigate` takes ownership
- relative links follow `document.baseURI`; cross-origin `navigate()` calls use full document navigation
- replace navigation preserves existing `history.state` unless an explicit `state` option is provided
- use `data-scroll-preserve="stable-key"` for scroll containers that should keep position
- do not pass `onNavigate` from a server page into an island prop; define navigation callbacks inside the island/client component


## Swap server-rendered pages

A host can let same-app links replace only the content column with the next server page. Declare it in server HTML and install it once from an island outside the column:

```html
<div data-nav-shell="app:user:locale:layout:build" data-nav-scope="/demo" data-nav-attributes="data-mode">
  <nav><a href="/demo/a">A</a></nav>
  <main data-nav-root><h1>A</h1></main>
</div>
```

```tsx
import { onCleanup, onMount } from "solid-js";
import { installPageSwap } from "@k2b/ssr/nav";

onMount(() => onCleanup(installPageSwap()));
```

- in a swap host, the loader imports modules used only outside the column first; a module with any instance in the column loads with the column (importing it mounts every instance), so an installer outside the column precedes column islands that write history; `listenPopState()` remains safe in either order
- `data-nav-shell` is an opaque signature; a fetched page with a different one loads as a document, so put app, user, locale, layout kind, and build into it
- `data-nav-scope` is a path prefix (`/demo` takes `/demo/x`, not `/demobox`); `data-nav-root` is the replaced column; `data-nav-attributes` lists shell attributes the fetched page sets or removes
- `data-nav-document` on a link keeps document navigation; mark in-scope links to non-HTML resources with it or `download`, otherwise the server receives the request twice (the swap fetch, then the document); prevented clicks, modifier keys, `target`, `download`, `rel="external"`, other origins, and same-page hash links stay native too
- the swap loads the new page's island modules before it disposes the old islands; then it pushes history, replaces the column, sets title and attributes, mounts, focuses the first heading, and announces the title; island cleanups should not navigate
- the newest navigation wins (another swap, Back/Forward, a native link, a native form submission, an enhanced `Link` click, `navigate()`, `documentNavigate()`), and a swap that starts later turns a pending `Link` handler's `push`, `replaceWith`, and `fallback` into no-ops; any failure (status, not HTML, redirect out of scope, signature, module prefix, `<base>`, stylesheet set, module error) loads the requested URL as a document
- `swapPage(href, { replace })` swaps from code
- `window` receives `ssr:nav-swapped` once per committed push, replace, Back or Forward, with `detail: { root }` for the inserted column, after mount, scroll, focus and announcement; failures and document loads emit nothing, and listener errors never trigger a document load
- inline scripts in the fetched page do not run; keep page data in island props
- Back and Forward swap another server page's column fresh from the server; a failure or a different final URL reloads the arriving URL. Same-page traversals reach `listenPopState()` without a fetch; cross-page traversals stay hidden from island listeners
- install before raw `popstate` listeners, or replace them with `listenPopState()`, which is safe in any order; code that keeps its own history bookkeeping, and shell code outside the swapped column (a panel, a rail), listens to `ssr:nav-popstate` on `window` for allowed cross-page swaps (`detail` is the hidden `PopStateEvent`)
- keep history state a plain object or `null`; nav keeps caller fields and reserves `"@k2b/ssr/nav"` for `{ page, position, scroll? }`. Non-plain state stays unchanged and unmarked, so returning to it fetches the page or reloads
- nav restores window and keyed region scroll from the arriving entry once, right after its islands mount; an island that loads its content later restores its own position, and same-page region scroll remains the island's job. `history.scrollRestoration` is `"manual"` while installed; uninstall restores the previous value for the current entry only, entries created meanwhile stay manual; the history wrappers remain but become inert
- reloads keep page identity, bfcache returns check the arriving entry, and dialog-only traversals remain with the dialog history owner
- add `data-scroll-page` to a keyed `data-scroll-preserve` region to restore it on Back/Forward and reload recovery without carrying the departing page's position into push or replace swaps; those start at the top or hash target

## Protect unsaved input

```tsx
import { onBeforeLeave, swapPage } from "@k2b/ssr/nav";

// In an island, while it renders or in onMount; the check ends with the island.
onBeforeLeave((event) => {
  if (!dirty()) return;
  event.preventDefault();
  // Async dialog: veto first, wait for history, then ask and retry.
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

- nav asks before an in-scope link click, `swapPage()`, and a Back/Forward that swaps to another server page; only islands inside the current `data-nav-root` are asked, shell islands are not; a check without an island owner applies until its returned disposer runs
- checks run synchronously in registration order; the first `preventDefault()` wins and later checks are not asked; a throwing check allows and is reported through `reportError()`; promises and return values are ignored (`window.confirm()` works)
- a vetoed click or `swapPage()` changes nothing: no fetch, no history entry, an older pending swap keeps running
- a vetoed Back/Forward aborts a pending swap and rolls history back to the shown entry with `navigation.traverseTo()` (or `history.go()` using marker positions when the departure key is unavailable); listeners registered after nav and `ssr:nav-popstate` see neither popstate (listeners registered before nav, such as `@k2b/ui` dialog-core, still do), and traversals during a pending rollback are absorbed; a failed rollback reloads unless a newer swap committed meanwhile; an unknown or zero delta cannot be vetoed
- document loads, island-owned navigation (`Link` with `onNavigate`, `navigate()`, same-page popstates), bfcache returns, and further traversals or fragment entries during a pending cross-page traversal are not asked
- nav does not consult `beforeunload` during a swap; keep `beforeunload` for document loads (reload, closed tab, out-of-scope link, a swap that fails and loads the document)
