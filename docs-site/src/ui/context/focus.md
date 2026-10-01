# Focus rings

Every interactive `@k2b/ui` control shows a visible ring when it has keyboard
focus (`:focus-visible`). The ring appears and disappears without moving or
resizing anything on the page.

## Where the ring sits

Outside a clipping container, the ring sits just outside the control, 2 px
wide with a 2 px gap.

A container that clips its content with `overflow` would cut off an outer
ring. Inside a clipping container, the ring is drawn inside the control
instead, along its edge. The container keeps its padding and the control
keeps its size, because only the painted ring moves.

The shared containers that clip their content already do this:
`AppWorkspace`, `Panes`, `ScrollArea`, `DetailPanel`, `DataPanel`,
`FloatingWindow`, `SettingsModal`, `PanelDialog`, prompts and dialogs,
`Disclosure`, menus and picker popovers, input fields, `Tabs`, `DataTable`,
`Pagination`, widgets, `StatGrid`, and the calendar, code, file, Markdown, chart,
image, template, and chat views that scroll or clip. This includes controls
you render inside these containers, such as a link in a table cell, and
controls in a `.k2b-ui` root nested inside them. Such a control can keep the
browser's default ring; the container still draws it inside.

A scrolling area that takes focus itself draws its ring inside its own edge.
This covers a `ScrollArea`, which Firefox focuses when it holds no focusable
content, and the keyboard-scrollable body of a `DataTable`, whose ring stays
visible above a sticky header or footer.

A filled control, such as a primary or danger button, a checked checkbox, or
a checked switch, draws its inside ring in the color of its label or check
mark, with a band of its fill left around the ring. The ring therefore stays
visible on the fill.

## Mark your own clipping containers

When your markup clips focusable content, add `k2b-focus-inset` to the
clipping element. Typical cases are a horizontally scrolling chip row, a cell
body with a maximum height, or a card with `overflow: hidden`:

```tsx
<div class="k2b-focus-inset flex gap-2 overflow-x-auto">
  <FilterChip label="Status" options={statusOptions} value={status} onValueChange={setStatus} />
  <FilterChip label="Owner" options={ownerOptions} value={owner} onValueChange={setOwner} />
</div>
```

Do not add padding, margins, or borders so that a ring fits. That would move
the content, and the inside ring already fits.

## Style a custom focus ring

When a custom control needs its own ring, use the focus tokens so that it
follows the same placement:

```css
.product-ui .timeline-marker:focus-visible {
  outline: var(--k2b-focus-width) solid var(--k2b-focus-ring);
  outline-offset: var(--k2b-focus-offset);
}
```

| Token | Meaning |
| --- | --- |
| `--k2b-focus-ring` | Ring color. |
| `--k2b-focus-width` | Ring width, 2 px by default. |
| `--k2b-focus-offset` | Gap to the control: 2 px outside by default, the negative ring width inside a clipping container. |
| `--k2b-focus-on-fill` | Set only inside a clipping container: the color for a ring drawn on a filled control. Use it as `var(--k2b-focus-on-fill, var(--k2b-focus-ring))`. |

Draw the ring with `outline`, or with an inset `box-shadow` sized by
`--k2b-focus-width`. An outer `box-shadow` cannot move inside a clipping
container. Never change `border-width`, `padding`, `margin`, or the size of a
control on focus.

## Focus after an overlay closes

When a dialog, prompt, menu, context menu, select list, date picker, sidebar
preview, lightbox, or floating window closes, focus returns to the control
that opened it. This is the same for Escape, a close button, or a chosen
item.

The ring on that control shows whether the keyboard was in use:

- After a keyboard open, the ring is visible, so a keyboard user sees where
  they are.
- After a click or tap, the ring is visible once the user works the overlay
  with the keyboard, for example with arrow keys and Enter to pick an item.
- After a click or tap and no key other than Escape, the control gets focus
  back without a ring. Screen readers still announce it, and the next Tab
  shows the ring again.

A text field that opened an overlay gets focus back as the browser shows it.
Open overlays through the shared components and `dialogCore` to get this
behavior. If your own code moves focus back after a pointer action, use
`element.focus({ focusVisible: false })`.

## Forced colors

In forced-colors mode, rings use the system color. Controls that show focus
with an inset shadow fall back to an inset outline in the same place.
