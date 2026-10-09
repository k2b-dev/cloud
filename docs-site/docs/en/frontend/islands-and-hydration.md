---
title: Islands and hydration
navTitle: Islands and hydration
section: Frontend
order: 840
description: Add browser interactivity to server-rendered pages without turning the whole page into a client application.
tags: [islands, hydration, solidjs]
updated: 2026-10-09
---

# Islands and hydration

Use an island for the smallest part of a server-rendered page that needs
browser state.

## Choose a file type

| File | Behavior |
| --- | --- |
| `*.tsx` | Server-only component |
| `*.island.tsx` | Server-rendered and hydrated in the browser |
| `*.client.tsx` | Browser-only wrapper with no server body |

An island or client component uses a default export. Import it by its full file
path so the SSR plugin can discover the suffix.

Do not re-export islands through a barrel.

## Cross the prop boundary

```tsx
// ItemActions.island.tsx
export default function ItemActions(props: {
  itemId: string;
  initialArchived: boolean;
}) {
  // Browser behavior lives here.
}
```

Props are serialized with Seroval. Pass data such as strings, arrays, plain
objects, dates, maps, and sets.

Do not pass functions, event handlers, Solid signals, DOM nodes, or arbitrary
class instances.

Pass the current route as a path, never as the absolute request URL. Behind
the gateway `c.req.raw.url` carries the internal upstream origin, such as
`http://app-mail:3000`, which the browser never sees. `requestPath(c)` from
`@k2b/cloud/ssr` returns `pathname + search`; the island resolves it with
`new URL(props.requestPath, window.location.origin)` when it needs an absolute
URL. The `boundaries` repository check rejects `c.req.url`, `c.req.raw.url`,
and `url.toString()` or `url.href` as JSX attribute values.

```tsx
// page.tsx
import { Layout, requestPath } from "@k2b/cloud/ssr";

return () => (
  <Layout c={c} title="Inventory">
    <InventoryWorkspace items={items} requestPath={requestPath(c)} />
  </Layout>
);
```

An island calls a typed API when it needs a server effect. It does not receive
a server callback as a prop.

## Browser-safe imports

An island may import:

- `@k2b/ui`;
- focused browser-safe Cloud adapters such as `@k2b/cloud/access/ui`;
- `@k2b/cloud/browser`;
- browser-safe shared contracts;
- SolidJS and browser utilities.

Do not import `@k2b/cloud/server`, `/services`, `/ssr`, or a domain
service that imports Bun SQL.

## Preserve the server result

Render the initial answer on the server. The island starts from serialized
state and enhances it.

When the island must reload that answer, pass both the snapshot and its exact
source through the query's `initial` option. A matching source avoids an
unnecessary hydration request. See
[Server-backed state](/en/docs/frontend/server-backed-island-state).

Do not hydrate the entire page to avoid designing the boundary. Large islands
increase bundle size and make server and browser ownership unclear.

Do not nest an island import inside another island or client component.

See [Browser clients and mutations](/en/docs/frontend/browser-clients-and-mutations)
for typed calls and writes from an island.

## Load media only in the browser

An island shows its server HTML until it mounts. Then it renders its own DOM
in that place, so the server elements are discarded. A server-rendered
`<video>` or `<audio>` with a `src` starts loading, is cut off when the island
mounts, and loads again. In WebKit on Linux, which plays media through
GStreamer, stopping a media element while it loads can freeze the page for
good.

Give media its source only in the browser. Size the box around it on the
server: until a video knows its own size, it has a default one, so an unsized
video moves the page once its metadata arrives.

```tsx
import { isServer } from "solid-js/web";

<div class="size-20">
  <video
    src={isServer ? undefined : `${url}#t=0.001`}
    class="size-full object-contain"
    preload="metadata"
    muted
    playsinline
  />
</div>;
```

## Clean up with values from creation

A non-keyed `<Show>` or `<Match>` passes its children an accessor. Once the
condition turns false, that accessor throws: `Stale read from <Show>.` (or
`<Match>`) in production builds, a longer "stale value" message in development.
That is also the moment its children unmount, so everything that runs during
unmount sees the closed accessor:

- `onCleanup` handlers and effect cleanups;
- props that the parent wrote as `value={item().field}`, because each read
  calls the accessor again;
- parent callbacks that a cleanup calls, such as a selection, dirty, or
  pending report.

A throw there stops the whole update: the island stops following clicks, or
the island error notice replaces it.

Capture what a cleanup needs when the component or effect starts, and let
callbacks receive the id instead of reading it from the accessor:

```tsx
function MessageBody(props: { messageId: string; onSelectionChange: (messageId: string, text: string) => void }) {
  // A body shows one message for its whole life.
  const messageId = props.messageId;
  onCleanup(() => props.onSelectionChange(messageId, ""));
  // ...
}
```

Use `<Show keyed>` when the child should start over for each value. It then
receives the value itself instead of an accessor.

No repository check covers this, because the stale read usually happens in a
parent's getter or callback. A behavior test that closes the `<Show>` while
the child is mounted catches it.

## When an island fails

Each island and client component instance mounts inside its own error
boundary. When it throws while it mounts, while its props are read, or during a
later update, for example a list row that cannot render new query data, Cloud
replaces only that instance with a short notice: "This section could not be
displayed." and a **Try again** button, in the reader's language. Every other
island on the page keeps working, including islands updated by the same signal
write.

**Try again** mounts the island again from its original props, as on page
load. The error still appears in the browser console, reported through
`reportError()` like any uncaught error.

The notice has the same compact size wherever it appears, so a failing small
island, such as a control in the header, takes more room than the control did.

`defineApp` sets this for every application. Do not wrap an island's root in an
`ErrorBoundary` for protection. Add one inside an island only when a part of it
needs its own recovery; the nearest boundary handles the error.

Dialogs from `prompts` and `dialogCore` and windows from `openFloatingWindow`
render outside the island that opens them. `@k2b/ui` gives each of them its
own boundary: failing content shows "This content could not be displayed."
inside the dialog or window, and the island keeps working. See
[Prompts](/en/ui/feedback/prompts#runtime).

Errors in event handlers and async callbacks outside a Solid computation do not
reach a boundary. Handle them where they happen, for example with a mutation's
`error()` or a toast.
