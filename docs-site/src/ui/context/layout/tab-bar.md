# TabBar

`TabBar` is the bottom navigation between a phone app's top-level pages: up to
five native links with an icon above each label. It is flat and opaque on the
page canvas, without a rule above it and without badges. The content's scroll
fade marks its edge while more content continues below.

## Import

```tsx
import { TabBar, type TabBarItem } from "@k2b/ui";
```

## Use TabBar

Place it in the `footer` of a [`MobileShell`](/en/ui/layout/mobile-shell). It
pads the bottom safe area itself, so its labels stay clear of the home
indicator.

```tsx
const items: TabBarItem[] = [
  { id: "start", label: "Start", icon: "ti ti-home", href: "/app/", current: true },
  { id: "tasks", label: "Tasks", icon: "ti ti-checkbox", href: "/app/tasks" },
];

<TabBar label="App" items={items} />
```

- `label` names the navigation landmark.
- Each item has a stable `id`, a short `label`, an `icon` class, and an `href`.
  Mark the open page with `current: true`.
- `title` is the header title of the item's page. The shell shows it while the
  page loads. It defaults to `label`; set it when the page has a different
  title, such as a Start tab whose page is titled with the app's name.
- At most five items render; further items are left out. Put the rest behind a
  destination such as Start or More that lists every page.
- The items share the width equally. Long labels end with an ellipsis, so keep
  them to one short word.

The bar is a set of links, not a tab widget: each item loads a page. The server
marks the current item, so the bar never changes after hydration.

A tap switches tabs at the first touch, as on a native tab bar: the item takes
the current item's colour, and the shell shows the item's page frame with its
`title` and an empty content area until the page arrives. The page loads at
the end of the tap. When it takes longer than a moment, the item's icon pulses.
A second tap on the item does not start the load over. Pressed and loading
change only colour and opacity, so nothing moves. The page frame and the
ignored repeat tap come from the shell in the browser; see
[MobileShell](/en/ui/layout/mobile-shell#runtime).

## Accessibility

The bar is a `<nav>` landmark named by `label`, with a list of links. The open
page carries `aria-current="page"` and is also shown by colour. Icons are
decorative; the visible label is the accessible name. Each item is at least
44 px high and has a visible focus ring.

## Runtime

`TabBar` is plain server-rendered markup with native links and needs no
hydration. Each link carries its page's title as `data-k2b-title`. The page
frame and the loading state need a mounted `MobileShell` or
`observeMobileShell()`; without either, the links still work, with the
pressed colour only.

## Example

```tsx
<MobileShell
  header={<MobileShell.Header title="Tasks" />}
  footer={
    <TabBar
      label="App"
      items={[
        { id: "start", label: "Start", icon: "ti ti-home", href: "/app/" },
        { id: "tasks", label: "Tasks", icon: "ti ti-checkbox", href: "/app/tasks", current: true },
        { id: "contacts", label: "Contacts", icon: "ti ti-address-book", href: "/app/contacts" },
      ]}
    />
  }
>
  <TaskRows />
</MobileShell>
```
