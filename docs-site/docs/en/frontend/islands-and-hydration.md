---
title: Islands and hydration
navTitle: Islands and hydration
section: Frontend
order: 840
description: Add browser interactivity to server-rendered pages without turning the whole page into a client application.
tags: [islands, hydration, solidjs]
updated: 2026-08-10
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
