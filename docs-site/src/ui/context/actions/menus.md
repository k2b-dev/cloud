# Dropdown and ContextMenu

`Dropdown` opens actions from a visible trigger. `ContextMenu` opens the same item model at the pointer position on right-click or beside its trigger from the keyboard. The parent supplies actions, links, and state changes.

## Use menus

Use `Dropdown` for secondary actions that need an explicit, keyboard-accessible trigger.

Use `ContextMenu` as a pointer shortcut on a record or canvas. Do not make it the only way to reach an action.
Give it the same items as the element's visible "…" `Dropdown`, so right-click and the button never disagree.

Set `keepNativeMenu` when the host wraps readable content, such as a message or a document. Links, form fields,
editable text, and a text selection inside it then keep the browser's own menu with Copy, Paste, and Open link, and
an enclosing `ContextMenu` does not take it over. Shift+F10 and the context menu key still open the app menu, except
in a field. A `ContextMenu` nested in another opens its own menu, by pointer and by keyboard.

Do not use either menu as a select input. Choose the control from the state the
user is editing:

| Task | Component |
| --- | --- |
| Run an action or open a link | `Dropdown` |
| Choose one form value | `Select` |
| Choose one compact toolbar value | `SelectChip` |
| Choose several values | `MultiSelectInput` |
| Filter an existing result set | `FilterChip` |

For rows that explain each choice or show unavailable reasons, use
[RichSelect](../input/rich-select) instead of building select rows in a `Dropdown`.

See [Select inputs](../input/select) for the controlled selection contracts.

Use an item's optional `trailing` JSX for quiet information such as a view
count. The link label stays the view name.

## Import

```tsx
import {
  ContextMenu,
  Dropdown,
  type DropdownItem,
  IconButton,
} from "@k2b/ui";
```

## Touch menus

On touch devices, every menu item in `Dropdown`, `ContextMenu`, `SplitButton`,
`SelectChip`, and `FilterChip` is at least 44 px (2.75rem) tall, also without
`variant="touch"`. Items sit close together, so the item itself grows instead
of reaching into its neighbour with an invisible tap area. This follows the
device, not the input in use: a laptop with a touch screen gets the taller
items with a mouse too, and devices without a touch screen keep the compact
32 px items.

Set `variant="touch"` on `Dropdown.Root` for larger touch targets on every
device. It uses rows at least 52 px high, 16 px labels, larger icons, and an
18rem minimum width.
An explicit `width` still takes precedence; the menu stays within the viewport
and scrolls when necessary. Keyboard navigation and selection behave the same.
Omitting `variant` (or using `variant="default"`) keeps the compact appearance
and 12rem minimum width. Trigger styling is configured separately.

```tsx
<Dropdown.Root items={items} variant="touch" align="end">
  <Dropdown.Trigger iconOnly label="Menu">
    <i class="ti ti-dots" aria-hidden="true" />
  </Dropdown.Trigger>
</Dropdown.Root>
```

Set `phone="sheet"` on `Dropdown.Root` to open the same items in a bottom sheet
below 48rem. The default `phone="menu"` keeps the menu beside its trigger.
Use `sheetTop={(close) => ...}` for a contextual heading or a visible Done
button above those items. Call `close` to dismiss through the same history and
focus lifecycle as the menu actions.
A controlled dropdown (`open` supplied) always stays a menu. Choices with
`closeOnSelect: false` keep the sheet open, with reactive checked state, just
as they do in the desktop menu. The inherited UI locale follows into the sheet.
Like the menu, the sheet closes when the dropdown becomes disabled or unmounts.
Other actions run after the sheet has left the history, so they may navigate
or open a dialog. Set `immediate: true` on an action that needs the tap itself,
such as a clipboard write or a download; it runs during the tap and must not
navigate or open a dialog.

## Search

Set `search` on `Dropdown.Root` when a menu is long enough that finding an
entry takes reading, such as a list of templates. A field sits above the
entries and keeps the focus: Up and Down mark an entry, Enter chooses the
marked one, Escape closes the menu, and the first entry is marked again after
each change of the query. Opening with Enter marks the first entry, so Enter,
Enter chooses it. The field is a combobox whose marked entry is its active
descendant inside a list box, the popup is a dialog, and a polite status says
how many entries match. The phone sheet shows the same field.

```tsx
<Dropdown.Root
  items={items}
  label="New task"
  search={{ label: "Find template" }}
>
  <Dropdown.Trigger>New task</Dropdown.Trigger>
</Dropdown.Root>
```

Without `filter`, a query keeps the actions and choices whose label or
description contains it, in their sections, and shows "No results" when none
does. Pass `filter(query)` to return other entries for a query, such as a
"Blank task "query"" entry that takes the query as a title; `status(query,
matches)` replaces the announced count. The query resets when the menu closes.
The field keeps the focus, also after a press on an entry, so a searchable menu
leaves out `secondary` and `labelAction` buttons, which no key could reach.

## Adopt a trigger

`attach` hands a menu an element rendered elsewhere as its trigger, such as a
server-rendered link in a page head. A plain click, Enter, Space, Up, or Down
opens the menu, and focus returns there when it closes; a modified or middle
click and Ctrl, Cmd, Shift, or Alt with Enter keep the link's own meaning. The element gets `aria-expanded` and
`aria-controls`. Render `aria-haspopup` with it on the server, so the HTML says
it opens a menu before any script runs. `AppWorkspace.Head`'s `primary.popup`
does that for the head's primary action.

```tsx
<Dropdown.Root items={items} label="New task" phone="sheet" attach={() => document.querySelector("a[data-workspace-primary]")} />
```

## Items and sections

Both components accept `DropdownItem[]`. An item is one of:

- an action with `label`, optional `icon`, and `action`;
- a link with `label`, `href`, and optional `external`; with an `action` as
  well, a plain click runs the action instead of following the link, while
  modified clicks, a middle click, and the link's context menu keep the link,
  for example for an in-app panel that also has its own address;
- a radio or checkbox choice with `choice`, `checked`, and `action`;
- a section with optional `sectionLabel` and nested actions or choices.

A choice can also take `href`: a plain click, Enter, or Space runs its action, while modified clicks and middle-click can open the link in a new tab.

A section with `layout: "row"` sets a few short radio choices side by side as
one segmented row, such as a sort direction or a color mode. Give it a
`sectionLabel`: the label names the choice above the row and for screen
readers, and an unlabeled row stays an unnamed group. It uses the
`SegmentedControl` look: an inset track with the selected choice raised, labels
only, so icons and check marks are left out. Keep it to labels that fit the
menu's width; longer choices belong in an ordinary section. Up and Down move
through the row like through any items, and Left and Right cycle within it.

A choice can carry a `secondary` action, `{ label, ariaLabel?, action }`, such
as **Only** beside a calendar's checkbox. It sits at the end of the row, shows
while the row is hovered or focused and always on a touch screen, and keeps
its place while hidden, so the row never changes width. Right moves from the
row to it and Left back; Up and Down skip it and move from row to row. A
labelled section can carry a `labelAction` of the same shape, such as **All**,
at the end of its label. Both keep the menu open.

Set `variant: "danger"` only on destructive items. `variant: "accent"` gives
the icon of the entry most people want the action color, such as a blank item
above a list of templates.

`note` adds one quiet sentence below the entries that explains them all, such
as what choosing one keeps. It is the menu's description for screen readers
and also shows in the phone sheet.

Set `icons="tile"` on `Dropdown.Root` when the icons tell entries apart, such
as templates: each icon then sits on a quiet square, and an `accent` entry's
square takes the selection tint.

Menus deliberately do not accept arbitrary interactive content. Use a dialog
for a form or richer workflow. Use `Select`, `MultiSelectInput`, `SelectChip`,
or `FilterChip` when the interaction edits a value or filter.

`Dropdown.Root` accepts `items`, `open`, `onOpenChange`, `position`, `align`,
`width`, `class`, `menuClass`, `label`, `disabled`, `phone`, `sheetTop`, `lazy`, `openAt`, `closeWith`, `search`, `attach`, `icons`, `note`, and `onClose`.
`openAt` hands over `open(anchor, returnFocus?)`, which opens the menu without
its trigger beside `anchor`: an element, or any object with
`getBoundingClientRect()`, such as a point inside a cell. Use it when the menu
belongs to content that has no button of its own, such as a grip, a
right-click, or Shift+F10 in a grid cell. Focus returns to `returnFocus` when
the menu or sheet closes, also after a press outside it. Pass a function when an
entry can move the place focus belongs to, such as moving a row; it is read as
the menu closes. Phones get the sheet as from a trigger. `closeWith` hands over
`close()`.
Set `lazy` on a menu that repeats on every row of a long list, such as a tree
or sidebar: its entries render when the menu first opens, so the page carries
each row's trigger but not each row's entries. Opening, focus, and keyboard use
stay the same.
`Dropdown.Trigger` owns the native button and its SSR-visible menu semantics.
Use its normal button appearance by default. Set `appearance="plain"` only
when a specialized component class owns the complete visual treatment.
An `iconOnly` trigger defaults to the quiet `ghost` variant and shows its
`label` as a tooltip, matching `IconButton`; pass another variant explicitly
when the icon action should be emphasized, and `tooltip` to change or omit the
hint.

## Menu width

Menus size to their entries, so a caller does not need to know a width. A menu
is as wide as its longest label, at least `12rem` (`18rem` for
`variant="touch"`, `13rem` for `FilterChip`, and `10rem` for `SelectChip`), and
at most the viewport width less `1rem` per side. An entry or section label
longer than that wraps instead of ending in an ellipsis, and an unbroken word
breaks, so every label stays readable on a phone. A description wraps at
`16rem` and never widens the menu past that, so a long explanation reads as a
short paragraph under its label instead of stretching the menu. A radio choice reserves its
check mark while unchecked, so choosing an option never widens an open menu.
`ContextMenu` follows the same rule with a `13rem` minimum and `0.5rem` to each
viewport edge, and is measured before it is clamped beside the pointer. When
entries change while a menu is open, it keeps its alignment with the trigger or
pointer and stays inside the viewport. Opening a menu never moves the trigger
or the page around it.

`width` is an optional exact override as a **CSS length string**, not a class
name. It sets the menu's `--k2b-dropdown-width`; entries wrap within it, and
the viewport bound still applies. Use it only when a menu must line up with
something else:

```tsx
<Dropdown.Root items={actions} width="18rem" position="bottom-left">
  <Dropdown.Trigger variant="secondary">Actions</Dropdown.Trigger>
</Dropdown.Root>
```

`ContextMenu` wraps `children` and uses the same `items` model. It also accepts
`disabled`, `onOpen`, `onClose`, an optional stable `id`, and an accessible
`label`.

## API reference

```ts
type DropdownActionBase = {
  class?: string; disabled?: boolean; icon?: string; image?: string; label: string; ariaLabel?: string; description?: string; trailing?: JSX.Element;
  variant?: "danger" | "accent";
};

type DropdownAction =
  | (DropdownActionBase & {
      action: () => void;
      closeOnSelect?: boolean;
      immediate?: boolean;
      href?: never;
      external?: never;
    })
  | (DropdownActionBase & {
      href: string;
      external?: boolean;
      action?: () => void;
    })
  | (DropdownActionBase & {
      disabled: true;
      action?: never;
      href?: never;
      external?: never;
    });

type DropdownChoice = DropdownActionBase & {
  action: () => void; checked: boolean | (() => boolean); choice: "checkbox" | "radio";
  href?: string; closeOnSelect?: boolean; color?: string; secondary?: DropdownSecondaryAction;
};

type DropdownSecondaryAction = { label: string; ariaLabel?: string; action: () => void };

type DropdownSection = {
  sectionLabel?: string; layout?: "row"; labelAction?: DropdownSecondaryAction;
  items: readonly (DropdownAction | DropdownChoice)[];
};

type DropdownItem = DropdownAction | DropdownChoice | DropdownSection;

type DropdownPosition = "bottom-right" | "bottom-left" | "top-right" | "top-left" | "right-start";

type DropdownProps = {
  items: readonly DropdownItem[]; children?: JSX.Element;
  position?: DropdownPosition | (() => DropdownPosition); variant?: "default" | "touch"; width?: string;
  class?: string; menuClass?: string; onClose?: () => void; open?: boolean;
  onOpenChange?: (open: boolean) => void; disabled?: boolean; label?: string; align?: "start" | "end"; phone?: "menu" | "sheet";
  sheetTop?: (close: () => void) => JSX.Element;
  lazy?: boolean;
  search?: DropdownSearch;
  attach?: () => HTMLElement | null | undefined;
  icons?: "plain" | "tile";
  note?: string;
};

type DropdownSearch = {
  label: string;
  placeholder?: string;
  filter?: (query: string) => readonly DropdownItem[];
  status?: (query: string, matches: number) => string;
};

type ContextMenuProps = {
  items: readonly DropdownItem[]; children: JSX.Element; class?: string | ((isOpen: boolean) => string);
  tabIndex?: number; disabled?: boolean; onClose?: () => void; onOpen?: () => void; id?: string;
  label?: string;
};
```

`DropdownActionBase` names the shared shape here; import the public `DropdownAction`, `DropdownChoice`, `DropdownSection` and `DropdownItem` types. Action callbacks return `void`; asynchronous work and its errors stay with the host. Actions and choices close on activation unless `closeOnSelect: false`. A section contains actions/choices, not nested sections.

Use `closeOnSelect: false` for an action that changes a value in place, such as a cycling setting. Keep the item object stable and expose changing `label`, `icon`, and `ariaLabel` fields as getters: the row updates in place and keeps focus. `ariaLabel` must contain the visible label.

`position` defaults to `"bottom-right"`; `align` (`"start" | "end"`) is an optional alignment override. `variant="default"`; `width` is an optional exact CSS length, and without it the menu sizes to its entries. Pair controlled `open` with `onOpenChange`, or omit both for internal state. When a key on the trigger opens a controlled menu and `onOpenChange` sets `open` right away, the focus moves to the first or last item, as in an uncontrolled menu; setting `open` from elsewhere leaves the focus where it is. `ContextMenu` has no controlled `open` prop. `DropdownItem` is also a low-level JSX export; normal consumers use the declarative `items` API above.

## Accessibility

`Dropdown.Trigger` renders `aria-haspopup` (`dialog` for a menu with
`search`, otherwise `menu`), `aria-expanded`, and `aria-controls` in server
HTML. Enter, Space, and arrow keys open it. Arrow
keys, Home, End, Escape, and Tab manage the open menu.

Unless `closeOnSelect: false`, declarative actions close the visible menu
before their callback runs. A state update in the callback therefore cannot
briefly repaint stale menu content.
Interactive menus close synchronously; `@k2b/ui` does not inherit a host's
generic `[popover]` exit transition. Animate decorative surfaces such as
tooltips separately instead of delaying an action menu's dismissal.

`ContextMenu` opens from the pointer context-menu event, the Context Menu key, or Shift+F10. From the keyboard it opens beside the focused element inside it, such as a row of a tree, and otherwise beside the wrapper. Pair it with a visible `Dropdown` when the same actions must remain discoverable without knowing the shortcut. For touch, [`GestureMenu`](../actions/gestures) adds swipe, double-tap, and long-press shortcuts to the same item model and opens the menu as a bottom sheet on phones and at the finger from 48rem.

Labels must describe the action without relying on their icons. External links open in a new tab with the appropriate relationship attributes.

## Runtime

Both menus require browser code. `Dropdown` uses the native Popover API, measures the trigger and menu, and clamps every supported position to an eight-pixel viewport inset. It repositions on viewport resize and ancestor scrolling.

`ContextMenu` renders its menu through a Solid portal, clamps pointer and keyboard openings to the viewport, and closes on outside pointer input, a change of the viewport's size, or scrolling outside the menu. A resize event that leaves the viewport's size unchanged keeps it open. Closing with Escape restores focus to the element inside it that had focus as the menu opened, such as a row or a day of a composite widget, and otherwise to the wrapper.

## Example

```tsx
const actions: DropdownItem[] = [
  {
    label: "Edit",
    icon: "ti ti-pencil",
    action: openEditor,
  },
  {
    label: "Delete",
    icon: "ti ti-trash",
    variant: "danger",
    action: confirmDelete,
  },
];

<Dropdown.Root items={actions}>
  <Dropdown.Trigger iconOnly label="Actions">
    <i class="ti ti-dots" aria-hidden="true" />
  </Dropdown.Trigger>
</Dropdown.Root>;
```
