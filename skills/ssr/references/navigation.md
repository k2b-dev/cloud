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
- this is not a router; do not expect route matching, nested routes, loaders, or server re-rendering
- without `onNavigate`, `Link` keeps native document navigation; `replace` and `scroll` only apply to enhanced clicks
- with `onNavigate`, update island state or load data first, then call `nav.push()`, `nav.replaceWith()`, or `nav.fallback()`
- when using `nav.push()`, subscribe with `listenPopState()` and restore island state from the URL on Back/Forward
- rejected async `onNavigate` callbacks fall back to full document navigation
- same-document hash links retain native scrolling unless `onNavigate` takes ownership
- relative links follow `document.baseURI`; cross-origin `navigate()` calls use full document navigation
- replace navigation preserves existing `history.state` unless an explicit `state` option is provided
- use `data-scroll-preserve="stable-key"` for scroll containers that should keep position
- do not pass `onNavigate` from a server page into an island prop; define navigation callbacks inside the island/client component
