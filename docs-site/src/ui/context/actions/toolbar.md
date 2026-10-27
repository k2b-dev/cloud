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

## Floating variant

Use `variant="floating"` for selection actions at the bottom of a column. It is always horizontal and never wraps. Its buttons have 44 × 44 px targets.

Place it last in a flex column: a heading, a scroll area with `flex: 1` and `min-height: 0`, then the toolbar. The column reserves the toolbar's height, keeping the final row clear. It can also be the last child inside a scroll container: the strip sticks to the bottom and reserves its own height after the rows. It never leaves its column: when the column is taller than the screen, the toolbar stays at the bottom of the visible part of the column.

Render it in an island. The browser measures it before its first paint, so it never rearranges after it appears; until then it is invisible but keeps its space. A toolbar under a hidden ancestor waits until it is shown. Without scripting, the server layout stays visible.

## Selection toolbar

Use `SelectionToolbar` for actions on selected text, such as formatting and
commenting in an editor. It holds a normal `Toolbar` (actions, separators, a
text button) and floats at the selection in the top layer, so no scroll
container clips it.

- Give `anchor` a function that returns the selection's box, or nothing while
  the toolbar should be closed. Open it after the pointer is released, not while
  someone drags the selection. The toolbar reads the box again while the page
  scrolls or resizes, so it stays attached.
- It sits centered above the selection with an 8 px gap. Near the top of
  `boundary`, such as the editor's scroll area under its own toolbar, it goes
  below the selection. On touch use `placement="below"`: the system's selection
  menu sits above.
- It is compact so it stays small over the text: a 4 px frame, 30 px buttons
  with 16 px icons, tight gaps and a slim separator. Use `Toolbar.Action` for
  icon commands and a `size="sm"` ghost `Button` for a text command such as
  Comment. On touch screens every button keeps a 44 px hit area through the
  buttons' own touch rule; the bar does not grow. Shortcuts from `keys` show in
  the tooltips only: the hints under the icons that the floating variant has do
  not fit.
- Pressing its buttons keeps the selection, so actions apply to it.
- Escape inside the toolbar calls `onEscape`; close the toolbar there and
  return focus to the text. Keyboard navigation is the `Toolbar` roving group.
- Show only actions the person may use. Someone who can only read gets no
  selection toolbar.

```tsx
<SelectionToolbar label="Selection" anchor={selectionBox} boundary={() => scroller} onEscape={close}>
  <Toolbar.Action label="Bold" icon="ti ti-bold" keys="mod+b" onClick={bold} />
  <Toolbar.Separator />
  <Button size="sm" variant="ghost" onClick={comment}><i class="ti ti-message-plus" /> Comment</Button>
</SelectionToolbar>
```

## Toolbar.Action

Use `Toolbar.Action` for ghost icon buttons. `label` names the button, its tooltip, and its row in the More menu; `icon` takes a class such as `"ti ti-archive"`. `disabled` applies to both the button and its menu row. `onClick` runs from either place.

In a floating toolbar, `priority` lets an action move into More when the column is too narrow. **1 is most important.** Larger numbers move first; equal priorities move the later action first. Omit `priority` to keep an action fixed. More is the last control and lists the moved actions in their original order. Widening the column brings them back. Inline toolbars keep every action in place; use `wrap` there.

`keys` uses the `Kbd` format, such as `"e"`, `"mod+j"`, or `"shift+arrowdown"`. It adds a hint under the icon, the platform shortcut to the tooltip, and `aria-keyshortcuts`. Hints appear with the [keyboard input flag](/en/ui/input-mode) and never move icons or resize buttons. The application still owns shortcut handlers.

To hide an action, stop rendering it, for example with `<Show>`. A `Toolbar.Group` hidden through its `class` also takes its actions out of More, because the toolbar measures again. A style that an outer element's class applies inside the toolbar is noticed only at the next resize. In a floating toolbar, empty groups and leading, trailing, or repeated separators are hidden. Keep fixed content compact. Actions move before a `Toolbar.Label` truncates; only when the fixed items alone are too wide does the label shrink.

## Toolbar.Label

`Toolbar.Label` is non-interactive text for a selection count or event title. It never moves into More. It stays on one line, can shrink, and truncates with an ellipsis at about 10rem.

## Accessibility

Always provide `label`. Name groups when their purpose is not obvious.

The roving group has one Tab stop: the last focused item, or the first item initially. Left/Right move and wrap in a horizontal toolbar (reversed in RTL); Up/Down do the same in a vertical toolbar. Home and End focus the first and last items. Modified keys and keys in menus keep their own behavior.

Roving items are buttons, links with `href`, checkboxes and other button-like inputs, and controls with `tabindex`. Text fields, textareas, selects, sliders, radio buttons, and editable regions stay their own Tab stops. They keep their arrow, Home, and End keys.

Hidden and natively disabled controls are skipped, as are controls inside menus, listboxes, dialogs, or popovers. The tab stop follows visibility. A toolbar that becomes visible later, or whose tab stop is hidden, picks the first visible control. `aria-disabled="true"` controls remain reachable; their handlers must guard unavailable actions.

More is the last roving control. Enter opens its menu; menu arrows navigate its rows. Escape closes the menu and returns focus to More. If a focused action moves into More after a resize, focus follows it to the More trigger.

Set `aria-pressed="true"` or `"false"` on toggle buttons. Pressed buttons use the action colour and selected background without changing their size or position. Forced colours use HighlightText on Highlight.

## Runtime

The layout renders on the server without roving `tabindex` attributes. Keyboard navigation and child action handlers require browser code.

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

## Example: mail selection

```tsx
<div style={{ display: "flex", "flex-direction": "column", height: "600px" }}>
  <h2>Inbox</h2>
  <div style={{ flex: "1", "min-height": "0", overflow: "auto" }}>
    {/* Message rows */}
  </div>
  <Toolbar label="Selection actions" variant="floating">
    <Toolbar.Label>3 selected</Toolbar.Label>
    <Toolbar.Action label="Reply" icon="ti ti-arrow-back-up" priority={2} keys="r" onClick={reply} />
    <Toolbar.Action label="Forward" icon="ti ti-arrow-forward-up" priority={7} keys="f" onClick={forward} />
    <Toolbar.Separator />
    <Toolbar.Action label="Archive" icon="ti ti-archive" priority={1} keys="e" onClick={archive} />
    <Toolbar.Action label="Later" icon="ti ti-clock" priority={3} keys="h" onClick={later} />
    <Toolbar.Action label="Move" icon="ti ti-folder" priority={4} keys="v" onClick={move} />
    <Toolbar.Action label="Delete" icon="ti ti-trash" priority={6} keys="delete" onClick={remove} />
    <Toolbar.Action label="Assistant" icon="ti ti-sparkles" priority={5} keys="mod+j" onClick={assistant} />
    <Toolbar.Separator />
    <Toolbar.Action label="Done" icon="ti ti-check" keys="escape" onClick={clearSelection} />
  </Toolbar>
</div>
```

The application provides the message rows and action handlers. Done and the selection count stay in the toolbar at every width.
