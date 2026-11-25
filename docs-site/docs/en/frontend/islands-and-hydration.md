---
title: Islands
navTitle: Islands
section: Frontend
order: 840
description: Add browser interactivity to server-rendered pages without turning the whole page into a client application.
tags: [islands, hydration, solidjs]
updated: 2026-11-25
---

# Islands

Use an island for the smallest part of a server-rendered page that needs
browser state.

## Choose a file type

| File | Behavior |
| --- | --- |
| `*.tsx` | Server-only component |
| `*.island.tsx` | Server-rendered, then rendered again in the browser |
| `*.client.tsx` | Browser-only wrapper with no server body |

An island or client component uses a default export. Import it by its full file
path so the SSR plugin can discover the suffix.

Do not re-export islands through a barrel.

## Know how an island mounts

The server renders each island's HTML into the page, so the first paint is
complete. When the island's code has loaded, the browser removes that HTML and
renders the component again from its serialized props. The browser does not
hydrate the server HTML; it replaces it. A later release of the island runtime
may hydrate islands instead.

This has two consequences:

- State that exists only in the server HTML inside an island is replaced when
  the island mounts. The runtime carries over two things: focus moves to the
  element at the same place in the new markup, and typed text moves to the
  same field, as described below. Everything else is lost, for example a
  scroll position or the value of a checkbox. Keep islands small so that they
  mount soon after the page appears, and derive the island's initial state
  from its props or the URL. `AppWorkspace.SidebarBody` restores its own
  scroll offset again on mount.
- The server and the browser must render the same markup from the same props.
  When they differ, the page moves as the island mounts. Do not read
  browser-only values such as the window width, `localStorage`, or the
  browser's clock during the first render. Pass the server's value as a prop,
  for example the server's render time, or read the value in `onMount` and
  reserve its space in the server markup.

Each island renders inside a `<solid-island>` element, and each client
component inside a `<solid-client>` element, with `display: contents`. Boxes
ignore the wrapper, but CSS selectors do not: `.list > .row`, `:last-child`,
and `+` see the wrapper as the child or the sibling. `@k2b/ui/v2.css` ships
each such rule also through one wrapper, so a v2 primitive in an island keeps
the layout of its place, and `describeV2` outlines it as if there were no
island. Your own CSS must allow for the wrapper in the same way, or select by
descendant.

Text a person typed into a text field (`<textarea>`, or `<input>` of type
text, search, email, url, or tel) before the island mounted moves to the same
field of the new markup. The field is found by tag, type, `name`,
`aria-label`, and its place among fields with the same four; when the new
markup has a different number of such fields, or the field is disabled or
read-only, the text is dropped and never given to another field. Fields that
exist only in the browser's markup, or that the island renders later, for
example behind `lazy` or `Suspense`, drop their text too.

Only fields that received a trusted `input` event count. `html()` writes an
inline listener at the start of `<body>` that records them; a custom template
must keep `body` before any island markup, or text typed above the listener
is not recorded. Values the browser restored by itself stay out; autofill
that fires a trusted `input` event counts as typed.

An `<input>` takes the typed value. A `<textarea>` does too, unless the
island put other text into it itself, such as a restored draft: then the
draft stays and what the person added to the server's text follows on a new
line. An emptied field stays empty. The field hears one bubbling `input`
event with `inputType: "insertReplacementText"`, and a `change` event: at
once when it was not the focused field, on leaving it otherwise. The focused
field keeps its focus and selection. While an input method composition runs
inside an island (a character still being built), the island mounts after
`compositionend`. Password, file, and other fields never move.

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

Props travel as Seroval JSON data, and the browser never evaluates them. Island
props do not need `'unsafe-eval'`. Pass strings, arrays, plain objects, dates,
maps, and sets.

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

A window `message` listener (including `window.onmessage`) compares
`event.source` with the window it expects before it acts, because any window
(frame, popup, or opener) can post to the page.

## Keep the first load small

Validators are large. Import schema-free values such as paths, limits, and
messages from their named module instead of a contract barrel such as
`@k2b/cloud/contracts`. Parse untrusted data with the schema in the code path
that receives it on demand. Cloud's own file, command, and live helpers keep
Zod out of the first load.

Every static import of an island downloads and runs before the island mounts,
on every page that renders it. Load code that only an action needs, such as a
settings dialog, an editor, an inspector, or a handoff to another app, inside
that action with `importOnDemand` from `@k2b/cloud/browser/reload`:

```tsx
import { importOnDemand } from "@k2b/cloud/browser/reload";
import { IconButton } from "@k2b/ui";
import { createSignal } from "solid-js";

export function InventorySettingsButton(props: { inventoryId: string; label: string }) {
  const [opening, setOpening] = createSignal(false);
  const open = async () => {
    if (opening()) return;
    setOpening(true);
    const dialog = await importOnDemand(() => import("./InventorySettingsDialog"));
    setOpening(false);
    if (!dialog) return;
    await dialog.openInventorySettings({ inventoryId: props.inventoryId });
  };
  return (
    <IconButton label={props.label} aria-busy={opening() ? "true" : undefined} onClick={open}>
      <i class={opening() ? "ti ti-loader-2 animate-spin" : "ti ti-settings"} aria-hidden="true" />
    </IconButton>
  );
}
```

While the code loads, the trigger shows a spinner in place of its icon and
ignores another activation, so a second click cannot open a second dialog.
It stays enabled: a disabled button loses focus, and the dialog could not
return focus to it when it closes.

A release replaces the application's code files. A page that was open before
the release cannot load code it has not loaded yet, and a dropped connection
fails the same way. `importOnDemand` then resolves `undefined` and shows a
toast that offers a reload, so the action only has to end.

Keep content that the page renders on mount in static imports; a dynamic
import there only delays it. Import types with `import type`; they never reach
the browser.

Never load a whole package entry such as `@k2b/ui` or `@k2b/stdlib/browser` on
demand when other browser code imports it statically. For a static import, the
bundler reads only the names you import from the package's re-exports. An
`import()` needs every export. The package entry then keeps all its re-exports,
and every island that imports the package statically keeps modules it never
uses in its first load. Import a small module on demand that re-exports only
the names it needs instead:

```ts
// pairing-toast.ts
export { toast } from "@k2b/ui";
```

```ts
void import("./pairing-toast").then(({ toast }) => toast(text));
```

The island build warns and names the file when code imports a package entry
on demand that only re-exports other modules and that browser code also
imports statically. The build still succeeds, so a dependency you cannot
change does not stop it. An entry that re-exports a single module, such as
`@k2b/ui/hover-card`, may load on demand. Inside the Cloud repository, the
`no-barrel-dynamic-import` rule makes this an error.

## Preserve the server result

Render the initial answer on the server. The island starts from serialized
state and enhances it.

When the island must reload that answer, pass both the snapshot and its exact
source through the query's `initial` option. A matching source avoids a
second request for the same data when the island mounts. See
[Server-backed state](/en/docs/frontend/server-backed-island-state).

Do not make the entire page one island to avoid designing the boundary.
Large islands increase bundle size and make server and browser ownership
unclear.

See [Browser clients and mutations](/en/docs/frontend/browser-clients-and-mutations)
for typed calls and writes from an island.

## Do not nest islands

An island or client module must never import another island or client module.
This includes direct imports, imports through plain modules, named imports,
and dynamic `import()` with a literal path. An island must also not import
itself back through plain modules. Type-only imports are fine. The build fails
in dev and production and names both files. The build cannot see an
`import()` whose path is computed at runtime, so do not use one for an island.

Each island file is its own browser entry with its own mount and error
boundary; imported into another island, it would render as a plain component.
A lazy import also loses its own mount, prop serialization, and error boundary,
so lazy-load a plain component module instead.

Move the shared component into a plain `.tsx` module and import it from both
files. Keep the island file as a thin default re-export:

```tsx
// InventoryFilter.tsx
export default function InventoryFilter(props: { initialQuery: string }) {
  return <input name="query" value={props.initialQuery} />;
}
```

```tsx
// InventoryFilter.island.tsx
export { default } from "./InventoryFilter";
```

## Load media only in the browser

An island discards its server HTML when it mounts (see
[Know how an island mounts](#know-how-an-island-mounts)). A server-rendered
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

## Island lifetime

An island lives until the document unloads or the framework disposes the content
around it. Disposal runs every Solid `onCleanup` and effect cleanup, also when
the island shows an error fallback. Use `onCleanup` to remove global listeners,
clear timers, and release subscriptions.

The wrapper dispatches a bubbling `ssr:island-dispose` event just before
cleanup. Code that renders outside the wrapper, such as a portal, can close
what the island opened. Disposal closes every open `@k2b/ui` dialog.

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
