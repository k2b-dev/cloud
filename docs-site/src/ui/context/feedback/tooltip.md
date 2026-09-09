# Tooltip

`Tooltip` adds a concise, non-interactive hint to an existing control. It opens for pointer hover and keyboard focus and keeps the surface inside the viewport.

## Use Tooltip

Use it to explain an icon-only or unfamiliar control.

Keep essential instructions and validation messages visible in the page. Use a popover or dialog when the content contains links, buttons, or other interaction.

## Import

```tsx
import {
  IconButton,
  Tooltip,
  type TooltipPlacement,
} from "@k2b/ui";
```

## Contracts

Buttons expose tooltip properties directly:

| Property | Type | Default | Purpose |
| --- | --- | --- | --- |
| `tooltip` | `JSX.Element \| false` | none | Supplies the non-interactive hint. |
| `tooltipPlacement` | `"top" \| "bottom" \| "left" \| "right"` | `"top"` | Requests the preferred side. |
| `tooltipDelay` | `number` | `250` | Sets the open delay in milliseconds; `0` opens immediately. |

Use `Tooltip.Anchor` as an explicit wrapper for non-button content. It accepts
`content`, `placement`, `delay`, `disabled`, and ordinary span attributes. Use
`Tooltip.Trigger` only for a specialized native button that does not use the
shared `Button` components. Neither contract searches or rewrites descendant
DOM.

Placement is a preference. The surface flips to the opposite side when the requested side does not fit and clamps to the viewport.

## Accessibility

The target receives `aria-describedby` after hydration. Keep the control's own accessible name; a tooltip description does not replace `aria-label`.

Tooltips open on focus as well as hover. Escape dismisses the current hint. Pointer down, pointer leave, focus out, scrolling, and resizing also close it.

Keep content short and non-interactive. Do not communicate required state through a tooltip alone.

## Runtime

The target and tooltip surface render on the server. Hydration attaches
`aria-describedby` to the explicitly owned target, opens the Popover API
surface, positions it, and handles dismissal.

Long content wraps within the maximum tooltip width. Keep hints concise.

## Example

```tsx
<IconButton label="Settings" tooltip="Application settings">
  <i class="ti ti-settings" aria-hidden="true" />
</IconButton>

<Tooltip.Anchor
  placement="bottom"
  content="This longer explanation wraps and remains inside the viewport."
>
  <span tabindex="0">Focus or hover</span>
</Tooltip.Anchor>
```
