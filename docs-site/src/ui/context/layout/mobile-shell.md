# MobileShell

`MobileShell` is the full-screen frame of a phone app: a header, one scroll
area, and an optional footer such as a [`TabBar`](/en/ui/layout/tab-bar). It
makes an installed web app feel like an app. The document never scrolls, pinch
zoom and rubber-banding are off, and toasts sit above the footer.

## Import

```tsx
import { MobileShell, TabBar } from "@k2b/ui";
```

## Use MobileShell

Mount one `MobileShell` per page, as the page's layout. Pass
`MobileShell.Header` as `header`, the page content as children, and a footer
when the page has one:

```tsx
<MobileShell
  header={<MobileShell.Header title="Tasks" back={{ href: "/app/", label: "Start" }} />}
  footer={<TabBar label="App" items={tabs} />}
>
  <TaskRows />
</MobileShell>
```

- `header` sits above the content and pads the top safe area (the notch or the
  Dynamic Island) and the side insets. `MobileShell.Header` takes a `title`, an
  optional `back` control (`href` renders a link, otherwise `onClick` a
  button, always with a `label`), and optional `actions` after the title.
- Children render in the shell's only scroll area, a
  [`ScrollArea`](/en/ui/layout/scroll-area) inside `<main>`. Its content pads the
  side insets, and the bottom safe area when no footer is visible.
- `footer` sits below the content and pads the bottom safe area (the home
  indicator) itself. `TabBar` does.
- `class` adds a class to the root, for example to set
  `--k2b-mobile-shell-gutter` (default `1rem`), the side padding of the header
  and content.

The root is `position: absolute; inset: 0`, never a fixed full-viewport layer.
Safari colours the status bar of an installed app from a fixed layer at the
top edge and keeps the colour it had for one that covers the whole viewport,
which after a dialog is the backdrop's dim. Header and footer are siblings of
the scroll area, not fixed or sticky layers.

### Touch rules

While a shell is mounted, these rules apply to the whole page, portalled
dialogs and menus included. They never apply to pages without a shell.

- `html` and `body` do not scroll and have `overscroll-behavior: none`, so
  there is nothing to rubber-band. Only the content scrolls, and it contains
  its own overscroll.
- Every element has `touch-action: pan-x pan-y`. iOS ignores
  `user-scalable=no`; this turns pinch zoom and double-tap zoom off. The app
  must therefore never rely on zoom: keep regular text sizes. The rule has no
  specificity, so a component that needs a gesture, such as a drag handle or a
  signature pad, claims it with its own `touch-action` rule.
- Buttons, menu triggers, and segmented controls are at least 44 px high on
  every pointer.
- Text fields have 16 px text and are at least 44 px high, so iOS never zooms
  into a focused field.

### Toasts

Toasts sit right above the footer, at every width, with the newest at the
bottom. While a modal dialog is open, the dialog owns the bottom edge, and
toasts use their usual place. The shell publishes the footer height as
`--k2b-mobile-shell-footer-height` on `body`.

While a toast without a timer is visible (`duration: 0` such as "You're
offline", a toast with running progress, or a `toast.custom` slot), the
content gets extra bottom padding of the height the toasts cover, so the last
row can still scroll above them.

### Status bar

Set the document's `theme-color` meta element and the `html` background to the
page background when the page loads. After the theme changes in the browser,
call `syncThemeColor()`: it copies the computed background of the first
`.k2b-ui` element (or the element you pass) to the `html` background and every
`theme-color` meta element, and drops their `media` attribute.

```ts
import { syncThemeColor } from "@k2b/ui";

document.body.dataset.theme = "dark";
syncThemeColor();
```

## Accessibility

`MobileShell.Header` renders the page title as the `<h1>`. Give every page a
title that names it. The Back control has an accessible name from `label`.

The content is the page's `<main>` landmark. Keep one primary action per
screen and secondary actions as text or icon buttons with labels.

Pinch zoom is off inside the shell. Keep body text at the regular size and
let text wrap rather than truncate where the content matters. Respect the
system text size: do not set fixed pixel heights on text rows.

## Runtime

The shell renders on the server in its final structure, so the header, the
content, and the footer stay in place when it hydrates. Only the end padding
of the content and the place of the toast rail settle after mount: in the
browser, the shell measures the footer and watches the toast rail to keep the
footer height and the toast padding current. It removes the footer
height when it unmounts.

`syncThemeColor()` is browser-only.

## Example

```tsx
const tabs = [
  { id: "start", label: "Start", icon: "ti ti-home", href: "/app/", current: true },
  { id: "tasks", label: "Tasks", icon: "ti ti-checkbox", href: "/app/tasks" },
  { id: "settings", label: "Settings", icon: "ti ti-settings", href: "/app/settings" },
];

<MobileShell
  header={
    <MobileShell.Header
      title="Start"
      actions={<IconButton label="Search" onClick={openSearch}><i class="ti ti-search" /></IconButton>}
    />
  }
  footer={<TabBar label="App" items={tabs} />}
>
  <TaskRows />
</MobileShell>
```
