# Buttons

`Button`, `ButtonLink`, `IconButton`, `IconButtonLink`, and `SplitButton` provide one semantic action hierarchy with consistent focus, sizing, and variants.

## Use Buttons

Use `primary` for the main forward action, `secondary` for supporting actions, `ghost` for quiet toolbar actions, `text` for inline disclosures without a surface or horizontal inset, `subtle` for compact contextual actions, `input` for actions placed directly beside a field, `warning` for time-sensitive or cautionary actions, `danger` for destructive work, and `success` only when success is the action's meaning.

## Import

```tsx
import { Button, ButtonLink, IconButton, IconButtonLink, SplitButton } from "@k2b/ui";
```

## Example

```tsx
<Button variant="primary" loading={saving()} loadingLabel="Saving">
  Save
</Button>

<Button variant="subtle" size="xs">
  <i class="ti ti-activity" aria-hidden="true" /> Status
</Button>

<Button variant="warning" size="xs">Undo send · 8s</Button>

<Button variant="text" size="xs">More</Button>

<IconButton label="Project settings">
  <i class="ti ti-settings" aria-hidden="true" />
</IconButton>

<IconButton label="Add filter" variant="input">
  <i class="ti ti-plus" aria-hidden="true" />
</IconButton>

<ButtonLink href="/settings" variant="secondary">Settings</ButtonLink>

<IconButtonLink href="/settings" label="Open settings">
  <i class="ti ti-external-link" aria-hidden="true" />
</IconButtonLink>

<SplitButton
  onClick={send}
  menuLabel="More send options"
  items={[
    { label: "Save as draft", icon: "ti ti-device-floppy", action: saveDraft },
    { label: "Send later", icon: "ti ti-clock", action: scheduleSend },
  ]}
>
  <i class="ti ti-send" aria-hidden="true" /> Send
</SplitButton>
```

`size` accepts `xs`, `sm`, `md`, or `lg`. `Button` defaults to `primary`; `IconButton` defaults to `ghost`. Loading disables the action, exposes busy semantics, and may replace the visible label through `loadingLabel`.

The `input` variant uses the same height, radius, muted surface, hover border, and inset focus treatment as form fields. Use it for a separate action immediately beside an input, not for actions embedded inside the field shell.

Button labels stay on one line by default, including loading labels. Let the surrounding toolbar wrap whole
actions when space is limited. Set `wrap` on `Button` or `ButtonLink` for
deliberately long or rich content that should wrap within the available width.
This also applies to buttons composed through `SplitButton`.

Button content is centered by default. Set `align="start"` on `Button` or
`ButtonLink` for a full-width row, such as a result or selection list. The row
content then starts at the leading edge, and the label fills the button. A
`min-w-0 flex-1` text block pushes trailing content, such as an action icon or
a tag, to the end. With `truncate`, long text ends in an ellipsis before it can
push that trailing content out. Button styles always win over utility classes,
so `justify-start` on a button has no effect; use `align` instead. `SplitButton`
does not take `align`.

```tsx
<Button variant="ghost" align="start" class="w-full" onClick={select}>
  <Avatar name="Maria Kolb" size="sm" />
  <span class="min-w-0 flex-1">
    <span class="block truncate">Maria Kolb</span>
    <span class="block truncate text-xs">maria@example.com</span>
  </span>
  <i class="ti ti-plus" aria-hidden="true" />
</Button>
```

Hover preserves each variant's color hierarchy. Pressing an immediate action adds a subtle inward scale without adding shadow depth or changing layout; a split button's main action moves the compound control, while its menu trigger opens without scaling. Reduced-motion preferences keep the color feedback without the scale.

Use `SplitButton` when one immediate action has closely related alternatives. The main segment remains a native button; the icon-only segment opens the existing `DropdownItem` menu contract. `variant`, `size`, `disabled`, and `loading` apply to both segments. `menuLabel` is required as the secondary trigger's accessible name.

Links use normal document navigation by default. Inside a hydrated SSR workspace, opt into the shared navigation contract explicitly:

```tsx
<ButtonLink href="/items" navigation="enhanced" scroll="preserve" onNavigate={refreshWorkspace}>
  More items
</ButtonLink>
```

Enhanced button links require `onNavigate`; without it they safely retain
native document navigation.

## Tooltip and split-button options

All button variants accept `tooltip?: JSX.Element | false`,
`tooltipDelay?: number` (250ms), and `tooltipPlacement?: "top" | "bottom" | "left" | "right"`
(default top). Use `false` to omit a tooltip. Content follows the
[Tooltip contract](/en/ui/feedback/tooltip).

`SplitButton` extends Button props with required `items: readonly DropdownItem[]`
and `menuLabel: string`. `menuPosition?: DropdownPosition | (() => DropdownPosition)`
and `menuWidth?: string` configure the menu; position defaults to `"bottom-left"` and width is a CSS length. See
[menu types](/en/ui/actions/menus#api-reference). Link buttons' `onNavigate`
uses the [navigation event contract](/en/ui/getting-started#icons-tones-and-navigation).

## Accessibility

All matching native button or anchor attributes pass through. The default button `type` is `button`, so form submission stays explicit. `IconButton` and `IconButtonLink` require `label`; `SplitButton` requires `menuLabel`. These labels supply the icon-only control's accessible name and title.

### Touch targets

On a device with a coarse pointer, such as a phone or tablet, every button, the
dialog close control, and a toast's action and close button accept taps in an
invisible area at least 44 px (2.75rem) tall and wide, centered on the control.
The visible size stays the same, so `xs`, `sm`, and icon-only buttons keep their
compact look. Tap areas end at the edge of a clipping container
(`overflow: hidden` or a scroll area).

A tap area never reaches back over the control before it. A button that
follows anything in its row, such as another button or a field, does not extend
backwards. The same applies when the button sits in up to two wrappers that
follow other content: an island from `@k2b/ssr`, a `Dropdown`, a
`Tooltip.Anchor`, or a `Toolbar.Group`. For example, header actions that each
hydrate as their own island keep each other's edges. The gap before the button
belongs to the control before it.

Above and below, the tap area reaches 8 px past an `sm` button and 10 px past
an `xs` button. A tap area that only touches the control above still takes a
one-pixel strip from its edge, so lines need a little more than that reach. On
touch devices, @k2b/ui's own button rows that wrap or stack keep 0.625rem
between lines: `DetailPanel` primary actions (also below the header's identity
row), `PdfPreview` actions, settings group and collection actions, image input
actions, and wrapping or vertical toolbars. `DetailPanel.Action` rows sit
flush, so on touch devices each row grows to 44 px itself and its tap area
keeps the row height.

In your own layouts, keep at least 0.625rem (0.75rem next to `xs` buttons)
between lines of compact buttons that wrap or stack, before a field or link
that follows a compact button, and before a button that sits in your own
wrapper element after other content. Where you can, place a row's islands
directly in the row instead of wrapping each one in its own element. Do not
set `position: static` on a button: the tap area is positioned against the
button itself.

## Runtime

Buttons render complete server HTML. Click and reactive loading behavior require hydration only when their state or handlers are client-owned.

For a selection with related actions (for example, an open file and file actions),
provide `primaryItems` and `primaryMenuLabel` to make the primary segment a
dropdown instead of an immediate action. `menuIcon` optionally replaces the
secondary chevron. Both menus use the same `DropdownItem` contract.
