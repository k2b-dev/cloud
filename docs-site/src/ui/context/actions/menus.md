# Dropdown and ContextMenu

`Dropdown` opens actions from a visible trigger. `ContextMenu` opens the same item model at the pointer position on right-click or beside its trigger from the keyboard. The parent supplies actions, links, and state changes.

## Use menus

Use `Dropdown` for secondary actions that need an explicit, keyboard-accessible trigger.

Use `ContextMenu` as a pointer shortcut on a record or canvas. Do not make it the only way to reach an action.

Do not use either menu as a select input. Choose the control from the state the
user is editing:

| Task | Component |
| --- | --- |
| Run an action or open a link | `Dropdown` |
| Choose one form value | `Select` |
| Choose one compact toolbar value | `SelectChip` |
| Choose several values | `MultiSelectInput` |
| Filter an existing result set | `FilterChip` |

See [Select inputs](../input/select) for the controlled selection contracts.

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

Set `variant="touch"` on `Dropdown.Root` for larger touch targets. It uses rows
at least 52 px high, 16 px labels, larger icons, and an 18rem default width.
An explicit `width` still takes precedence; the menu stays within the viewport
and scrolls when necessary. Keyboard navigation and selection behave the same.
Omitting `variant` (or using `variant="default"`) keeps the compact appearance
and 12rem default width. Trigger styling is configured separately.

```tsx
<Dropdown.Root items={items} variant="touch" align="end">
  <Dropdown.Trigger iconOnly label="Menu">
    <i class="ti ti-dots" aria-hidden="true" />
  </Dropdown.Trigger>
</Dropdown.Root>
```

## Items and sections

Both components accept `DropdownItem[]`. An item is one of:

- an action with `label`, optional `icon`, and `action`;
- a link with `label`, `href`, and optional `external`;
- a radio or checkbox choice with `choice`, `checked`, and `action`;
- a section with optional `sectionLabel` and nested actions or choices.

Set `variant: "danger"` only on destructive items.

Menus deliberately do not accept arbitrary interactive content. Use a dialog
for a form or richer workflow. Use `Select`, `MultiSelectInput`, `SelectChip`,
or `FilterChip` when the interaction edits a value or filter.

`Dropdown.Root` accepts `items`, `open`, `onOpenChange`, `position`, `align`,
`width`, `class`, `menuClass`, `label`, `disabled`, and `onClose`.
`Dropdown.Trigger` owns the native button and its SSR-visible menu semantics.
Use its normal button appearance by default. Set `appearance="plain"` only
when a specialized component class owns the complete visual treatment.
An `iconOnly` trigger defaults to the quiet `ghost` variant, matching
`IconButton`; pass another variant explicitly when the icon action should be
emphasized.

`width` is a **CSS length string**, not a class name. It sets the menu's `--k2b-dropdown-width` and defaults to `12rem`:

```tsx
<Dropdown.Root items={actions} width="18rem" position="bottom-left">
  <Dropdown.Trigger variant="secondary">Actions</Dropdown.Trigger>
</Dropdown.Root>
```

`ContextMenu` wraps `children` and uses the same `items` model. It also accepts
`disabled`, `onOpen`, `onClose`, an optional stable `id`, and an accessible
`label`.

## Accessibility

`Dropdown.Trigger` renders `aria-haspopup`, `aria-expanded`, and
`aria-controls` in server HTML. Enter, Space, and arrow keys open it. Arrow
keys, Home, End, Escape, and Tab manage the open menu.

Declarative actions close the visible menu before their callback runs. A state
update in the callback therefore cannot briefly repaint stale menu content.
Interactive menus close synchronously; `@k2b/ui` does not inherit a host's
generic `[popover]` exit transition. Animate decorative surfaces such as
tooltips separately instead of delaying an action menu's dismissal.

`ContextMenu` opens from the pointer context-menu event, the Context Menu key, or Shift+F10. Pair it with a visible `Dropdown` when the same actions must remain discoverable without knowing the shortcut.

Labels must describe the action without relying on their icons. External links open in a new tab with the appropriate relationship attributes.

## Runtime

Both menus require hydrated browser code. `Dropdown` uses the native Popover API, measures the trigger and menu, and clamps every supported position to an eight-pixel viewport inset. It repositions on viewport resize and ancestor scrolling.

`ContextMenu` renders its menu through a Solid portal, clamps pointer and keyboard openings to the viewport, and closes on outside pointer input, resize, or scrolling. Closing with Escape restores focus to the trigger.

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
