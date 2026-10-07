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
`description`, `active`, `disabled`, `color`, secondary `actions`, and
`inlineActions`. Everything in the item tree is serializable; functions remain
in the controller.

Secondary `actions` open from the row's menu button with their `label`, `icon`,
`description`, and `disabled` state, so a disabled action can say why.

`inlineActions` sit directly in the row, after the destination and before the
menu button, as square 44 px icon buttons. Use them for one or two actions that
belong beside the destination on every screen, such as mailbox details next to
Compose. Each needs an `icon`; its `label` is the button's accessible name and
tooltip. They take an `action` key or an `href` like any item and follow the
row's and their own `disabled` state. Keep longer lists in `actions`.

```tsx
{
  id: "compose",
  label: "Compose",
  href: "/compose",
  inlineActions: [{ id: "details", label: "Mailbox details", icon: "ti ti-info-circle", action: "details" }],
}
```

A group without its own action toggles its children when selected and shows a
chevron. Set `defaultExpanded: false` to start a group collapsed; omitted groups
start expanded. Later toggles belong to the renderer and do not change the model.

When disclosure must outlive one renderer, for example in a menu that mounts a
new `Navigation` each time it opens, the owner keeps it: set `expanded` on the
item and handle `onExpandedChange(id, expanded)` in the controller. The renderer
then shows `expanded` and reports toggles instead of keeping them; without a
handler the item does not change.

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

`createNavigation({ items, onAction?, onNavigate?, onExpandedChange? })` returns
`items`, `onNavigate`, `onExpandedChange`, and `activate(id)`. `activate`
resolves the latest enabled item before calling its action.
`findNavigationItem(items, id)` exposes that lookup.

## Accessibility

Use a meaningful `label` for the navigation landmark. Native links and buttons
keep keyboard behavior; disclosure controls expose `aria-expanded` and active
links expose `aria-current`. Disabled ancestors disable child controls too.

## Runtime

Items are read reactively. Only local selection state and disclosure of items
without an owner-held `expanded` state belong to this renderer.
The host owns opening, closing, history, and the source of live updates.

## Example

The live showcase renders one controller inline and inside a sheet. Simulate a
live update while the sheet is open to check that the badge changes in place.
