# Navigation

## Use Navigation

`createNavigation` keeps a reactive navigation model and its action handler
with the owning Solid component. `Navigation` renders readable, nested rows.
The library does not own the app router, subscriptions, permissions, or a
mobile launcher.

## Label overflow

Navigation labels fade, never end in an ellipsis. Use the shared utilities for
app-owned sidebar, tree, rail, tab, chip, and launcher labels inside `.k2b-ui`:

- `k2b-truncate-fade` keeps one line and fades its last 1.5rem.
- `k2b-truncate-fade-lines` wraps up to two lines and fades the last line over
  half its width. Set `--k2b-truncate-fade-lines` to change the line count. For
  one line, set it to `1` together with `white-space: nowrap`. Give it a line
  height of at least 1.3, or glyphs that reach past the line box count as
  overflow and fade a label that fits.
- `--k2b-truncate-fade-inset` reserves the covered end when hover actions
  overlay the text. It inherits from the row and includes the fade before the
  actions. A fading label inside another one or inside row metadata resets it
  to `0px`, because it does not end where the actions start.

Put the class on a non-focusable inner text element that is a block or flex
item. A mask on a link, button, or focusable heading would clip its focus
ring. Keep the full text in the DOM for the accessible name.

Labels that fit stay undimmed. CSS scroll timelines enable the fade only when
text overflows. An engine without scroll timelines cannot tell the two apart,
so there an overflowing label ends in an ellipsis and a label that fits stays
as it is. WebKit can update the fade a moment late after a container changes
width. RTL text fades on the left. The mask works on any fill, including
hover, selection, and dark surfaces. Menu rows that wrap without clipping can
keep wrapping.

The detection runs as CSS animations on scroll timelines, which keep running
and never finish. A browser test that waits for page animations to settle
selects `document.getAnimations().filter((animation) => animation.timeline === document.timeline)`.

```tsx
// The row is a flex container, so the label is a flex item.
<a href="/projects" class="project-row">
  <i class="ti ti-folder" aria-hidden="true" />
  <span class="k2b-truncate-fade">{project.name}</span>
</a>
```

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
key, or `children`. Optional fields are `icon`, `iconLabel`, `badge` (string or
number), `description`, `status`, `active`, `disabled`, `color`, secondary
`actions`, and `inlineActions`. Everything in the item tree is serializable;
functions remain in the controller.

`icon` is decorative unless `iconLabel` names it. Set `iconLabel` only when the
icon carries meaning the label does not, such as a home icon on the note that
is a notebook's homepage; screen readers then read it with the row.

`status` puts one icon at the row's end, before its buttons, in a slot of fixed
size: `{ icon, label, tone? }`. The `label` is part of the row's accessible name
and its tooltip; `tone` takes the intent tones `neutral`, `info`, `success`,
`warning`, and `danger`. Use it for a state that comes and goes, such as
"running" or "waiting for you", instead of a `description`, which adds a second
line. Set `status: null` on rows whose status can appear later: the empty slot
keeps its place, so a long label wraps the same way and the rows below do not
move when a status appears.

```tsx
{ id: "offer", label: "Offer for Jana", href: "/chats/offer", status: running() ? { icon: "ti ti-loader-2", label: "Running" } : null }
```

A group with `section: true` and no `href` or `action` is a section: a quiet
heading over its rows, always open and not indented, for lists sorted into
parts such as days. Its rows form a list labelled by the heading.

```tsx
{ id: "today", label: "Today", section: true, children: todaysChats().map(chatItem) }
```

Secondary `actions` open from the row's menu button with their `label`, `icon`,
`description`, and `disabled` state, so a disabled action can say why.

`inlineActions` sit directly in the row, after the destination and before the
menu button, as square 44 px icon buttons. Use them for one or two actions that
belong beside the destination on every screen, such as mailbox details next to
Compose. Each takes an `id`, a `label` as the button's accessible name and
tooltip, an `icon`, and an `action` key, and follows the row's and its own
`disabled` state. Inline actions do not navigate: a destination belongs in a
row, where its link keeps modified clicks and new tabs. Keep longer lists in
`actions`.

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

Set `keepOpen: true` on an action that changes only what the menu shows, such
as a filter or a sort order. It runs without `beforeSelect`, so the menu stays
open and shows the result. Leave it off for an action that opens something,
such as a dialog or a new item, and for every link.

```tsx
{ id: "favorites", label: "Favorites", action: "filter:favorites", keepOpen: true, active: showsFavorites() }
```

`createNavigation({ items, switcher?, onAction?, onNavigate?, onExpandedChange? })` returns
`items`, `switcher`, `onNavigate`, `onExpandedChange`, and `activate(id)`. `activate`
resolves the latest enabled item before calling its action.
`findNavigationItem(items, id)` exposes that lookup.

## Container switcher

Pass `switcher: () => props` to show an
[AppWorkspace.SidebarSwitcher](/en/ui/layout/workspace#switcher) before the
rows inside the navigation landmark. The accessor returns
`AppWorkspaceSidebarSwitcherProps`, including reactive `options`, `onLoad`,
and permission-filtered `actions`. Reuse the sidebar's props so a phone host
menu shows the same container head and loads the same options on demand.
Omit `switcher` for navigation without a current container; no head or space
is added.

```tsx
const navigation = createNavigation({ items, switcher: () => switcher });
<Navigation navigation={navigation} label="Notebook" />
```

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
live update while the sheet is open to check that the badge changes in place
and that the status of the first row under **Today** comes and goes without
moving a row.
