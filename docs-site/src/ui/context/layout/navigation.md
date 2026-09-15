# Navigation

## Use Navigation

`createNavigation` keeps a reactive navigation model and its action handler
with the owning Solid component. `Navigation` renders readable, nested rows.
The library does not own the app router, subscriptions, permissions, or a
mobile launcher.

## Import and example

```tsx
import { createNavigation, Navigation } from "@k2b/ui";

const navigation = createNavigation({
  items: () => [
    { id: "inbox", label: "Inbox", href: "/inbox", badge: unread() },
    { id: "new", label: "New message", action: "compose", disabled: sending() },
  ],
  onAction: action => { if (action === "compose") openComposer(); },
});
<Navigation navigation={navigation} label="Mail" />
```

Items use stable, unique `id` values, a `label`, and either `href`, an `action`
key, or `children`. Optional fields are `icon`, `badge` (string or number),
`description`, `active`, `disabled`, `color`, and secondary `actions`. Everything
in the item tree is serializable; functions remain in the controller.

A parent destination and its expansion button are separate controls. Disabled
parents also disable their descendants. Labels wrap naturally; long lists
scroll in the host's body. Row identity survives badge and active-state updates.

Links preserve modified clicks and new-tab behavior. Document navigation is
the default. An island can opt into `navigation: "enhanced"`, `scroll`, and a
controller-level `onNavigate` handler. A link may also specify an `action` for
ordinary clicks that open local state before navigating; modified clicks still
use its URL. Keep slow requests outside view transitions.

The optional `beforeSelect` hook lets a host dismiss its menu before running an
action or following a link. Returning `false` cancels selection. Cloud uses it
to complete the temporary menu history entry before committing navigation.
Standalone hosts can compose this renderer with [BottomSheet](/en/ui/layout/bottom-sheet).

`createNavigation({ items, onAction?, onNavigate? })` returns `items`,
`onNavigate`, and `activate(id)`. `activate` resolves the latest enabled item
before calling its action. `findNavigationItem(items, id)` exposes that lookup.

## Accessibility

Use a meaningful `label` for the navigation landmark. Native links and buttons
keep keyboard behavior; disclosure controls expose `aria-expanded` and active
links expose `aria-current`. Disabled ancestors disable child controls too.

## Runtime

Items are read reactively. Only local selection state belongs to this renderer.
The host owns opening, closing, history, and the source of live updates.

## Example

The live showcase renders one controller inline and inside a sheet. Simulate a
live update while the sheet is open to check that the badge changes in place.
