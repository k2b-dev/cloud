# Toolbar

`Toolbar` gives related actions one semantic and responsive container.

## Use Toolbar

Use it for editor commands, table actions, and compact page controls. Use `Toolbar.Group` for named clusters, `Toolbar.Separator` between clusters, and `Toolbar.Spacer` before a trailing primary action.

## Import

```tsx
import { Button, IconButton, Toolbar } from "@k2b/ui";
```

## Layout

Enable `wrap` where actions may outgrow the available width. Button variants remain yours.

Separators automatically follow the toolbar orientation: they are vertical in a horizontal toolbar and horizontal in a vertical toolbar.

## Accessibility

Always provide `label`. Name groups when their purpose is not obvious.

The toolbar has one Tab stop: the last focused item, or the first item initially. Left/Right move and wrap in a horizontal toolbar (reversed in RTL); Up/Down do the same in a vertical toolbar. Home and End focus the first and last items. Modified keys and keys in text fields or menus keep their own behavior.

Items are rendered buttons, links with `href`, inputs, selects, textareas, and controls with `tabindex`. Hidden and natively disabled controls are skipped, as are controls inside menus, listboxes, dialogs, or popovers. `aria-disabled="true"` controls remain reachable; their handlers must guard unavailable actions.

Set `aria-pressed="true"` or `"false"` on toggle buttons. Pressed buttons use the action colour and selected background without changing their size or position. Forced colours use HighlightText on Highlight.

## Runtime

The layout renders on the server without roving `tabindex` attributes. Keyboard navigation and child action handlers require hydration.

## Example

```tsx
<Toolbar label="Document actions" wrap>
  <Toolbar.Group label="History">
    <IconButton label="Undo"><i class="ti ti-arrow-back-up" /></IconButton>
    <IconButton label="Redo"><i class="ti ti-arrow-forward-up" /></IconButton>
  </Toolbar.Group>
  <Toolbar.Separator />
  <Button size="xs" variant="subtle">Status</Button>
  <Toolbar.Spacer />
  <Button size="sm">Publish</Button>
</Toolbar>
```
