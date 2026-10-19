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

- `data-nav-shell` is an opaque signature; a fetched page with a different one loads as a document, so put app, user, locale, layout kind, and build into it
- `data-nav-scope` is a path prefix (`/demo` takes `/demo/x`, not `/demobox`); `data-nav-root` is the replaced column; `data-nav-attributes` lists shell attributes the fetched page sets or removes
- `data-nav-document` on a link keeps document navigation; prevented clicks, modifier keys, `target`, `download`, `rel="external"`, other origins, and same-page hash links stay native too
- the swap loads the new page's island modules before it disposes the old islands; then it pushes history, replaces the column, sets title and attributes, mounts, focuses the first heading, and announces the title; island cleanups should not navigate
- the newest navigation wins (another swap, Back/Forward, a native link, a native form submission, an enhanced `Link` click, `navigate()`, `documentNavigate()`); any failure (status, not HTML, redirect out of scope, signature, module prefix, `<base>`, stylesheet set, module error) loads the requested URL as a document
- `swapPage(href, { replace })` swaps from code
- inline scripts in the fetched page do not run; keep page data in island props
- Back and Forward are not swapped yet: install marks a null-state entry, swap entries carry their page's marker (kept across a reload), and only entries with the shown page's marker, a fresh hash-link entry, or, on a page loaded normally that has not swapped, unmarked island entries stay with islands; any other entry loads the document
- a swap does not fire `beforeunload`: an island with unsaved input prevents in-scope link clicks itself (a document capture listener calling `preventDefault()`) or the links carry `data-nav-document`
