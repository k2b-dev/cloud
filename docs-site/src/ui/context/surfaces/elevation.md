# Shadows and overlays

Cloud is flat. A shadow means one thing: this lies **over** the page
([Flat criteria](/en/ui/surfaces/flat-criteria) K3, K16). The app card, its
columns, sections, cards, groups, and buttons never cast one. Structure is a
hairline (K2): between columns, under a head, under rows, and between the
sections of a Detail column. One line has one owner: the container or the
column boundary draws it, never both neighbours.

## Use a shadow only for what floats

Before you give anything depth, ask: does it lie over the page? A menu, a
dialog, a toast, a drawer, a sheet, and a floating pill do; a card, a column,
a section, or a button does not.

## What floats, and how

An overlay is an object: round like a control, with a shadow, and flat inside
again (bands, hairlines, square rows). Choose the kind of overlay; shadow,
radius, and background follow from this table.

| Overlay | Shadow | Background behind it | Radius |
| --- | --- | --- | --- |
| Menu, submenu, popover | small: `--k2b-shadow-overlay-sm` | stays as it is | 8 px |
| Toast | small, only the front one | stays as it is | 8 px |
| Dialog | large: `--k2b-shadow-overlay-lg` | dimmed 28 % (`--k2b-scrim`), never blurred | 8 px |
| Drawer (Detail on a tablet) | towards the side: `--k2b-shadow-side` | stays as it is | 0, it is a column |
| Sheet below 768 px | upwards: `--k2b-shadow-sheet` | dimmed 28 %, never blurred | 14 px at the top, with a grip |
| Floating pill, main action on a phone | small | stays as it is | fully round |
| Drag preview | small | stays as it is | 8 px |

The page behind is dimmed only when it is locked (dialog, sheet). A dialog
replaces the one before it; dialogs do not stack.

## Not a shadow

| Part | Instead |
| --- | --- |
| App card | a hairline frame and the card radius (14 px) on the app canvas |
| Column boundary | one hairline; a draggable one carries a grip (K13) |
| Head of a column | the head line, which carries the selected tab's 2 px mark |
| Section, `Paper`, card in a column | no frame in a column; a framed topic on a full page has a 1 px edge |
| Selection, focus, error | fill, edge, and text, never depth |

The former layer tokens without an overlay (`--k2b-shadow-surface`,
`--k2b-shadow-raised`, `--k2b-shadow-column-*`, the island hook
`--k2b-island-shadow`) stay as names so existing code keeps building, and
draw nothing. `--k2b-shadow-frame` is only the app card's hairline edge.

## Glass

Glass (`k2b-overlay-surface`) stays the one exception, for a floating layer
over a picture, video, or map. It uses `--k2b-overlay-lift`. A toolbar over a
document is solid, so text that scrolls beneath it never shows through. No
dialog or sheet blurs the page behind it.

## Floating pills

A floating pill of small controls carries the class `k2b-pill`: fully rounded,
a light 1 px edge, a solid elevated surface, and the small overlay shadow
(`--k2b-shadow-toolbar`).
`Toolbar variant="floating"` is one, and so are an editor's formatting pill,
the `PdfViewer` bar, and the zoom and actions of the `Lightbox`. Put the class
on your own pill instead of styling one; with `k2b-overlay-surface` it is glass
over a picture. A floating toolbar floats at the bottom of its column, and
content scrolls beneath it but still ends above it, so the last line stays
reachable.

Every pill has the same size: 24 px round controls (`--k2b-pill-control`) 6 px
inside the 1 px edge (`--k2b-pill-inset`), so 38 px high with the same 7 px
between the edge and each control above, below, and at the sides. A control
inside a pill is round, also a filled one with text such as Open, so its hover
and its focus ring keep that space too: the inner radius is the outer radius
minus the space. Icons are 14 px, text 12 px. Touch screens keep the 44 px hit
area through the buttons' own touch rule; the pill does not grow.

A lone chevron in an icon button, such as the round previous and next buttons
of the `Lightbox`, moves a sixteenth of its size toward its point, so it looks
centred in the round button.

For two pills at the edges of one column, such as formatting at the left and
comments, reading, and details at the right, put both into one `ToolbarDock`
(see the example below). Each pill moves its own lower-priority actions into
More when the row gets narrow.

## Fades

Scroll and hover fades always end in the surface colour, through a mask:
`data-scroll-fade`, `ScrollArea`, or the content's own `mask-image`. A dark
inner shadow as a fade is never used. `HoverPreview` and `HoverCard` float on
layer 3 with `--k2b-shadow-float` outside and no inner shade.

A reading column's views and actions float in `FloatingPill`, which is a
`k2b-pill` placed at the column's top end (see
[AppWorkspace](/en/ui/layout/workspace#reading-column)).

## How an app gets it for free

- **Use the components.** `AppWorkspace` draws the column lines, the head line,
  and the app card. Menus, popovers, dialogs, sheets, toasts, and the floating
  pill bring their own shadow and radius.
- **Draw no edge of your own** at a column's side or under a head: the
  boundary and the head own those lines. Use `k2b-divided` on a container to
  part its children with hairlines.
- **An app-owned overlay** reads `--k2b-shadow-overlay-sm` or
  `--k2b-shadow-overlay-lg` and the overlay radius; nothing else gets a
  shadow.
- **A justified exception** names its reason in a comment on the line above:
  `/* shadow-tokens: allow <reason> */` (or `{/* … */}` in JSX). An example
  is a resize handle on a photo, which needs a halo on any picture.

## Import

The tokens and rules ship in `@k2b/ui/styles.css` below the nearest `.k2b-ui`
scope. The components that float come from the package root:

```tsx
import { Dropdown, FloatingPill, Toolbar } from "@k2b/ui";
```

## Accessibility

A shadow is never the only signal. Overlays keep their 1 px edge, which stays
visible in forced colours, where shadows disappear. Selection, focus, and
errors show through fill, edge, and text, never through depth. Floating pills
keep 44 px touch targets, and the content end stays reachable above them for
keyboard and screen reader users.

## Runtime

Shadows and lines are CSS only. They render on the server and need no browser
code, so the first paint already shows the final look. Dark mode switches with
the theme of the `.k2b-ui` scope.

## Example

```tsx
// An app-owned popover floats: overlay shadow and radius.
.board-preview {
  border: 1px solid var(--k2b-border);
  border-radius: var(--k2b-radius-overlay, 8px);
  box-shadow: var(--k2b-shadow-overlay-sm);
}

// A list in a column stays flat: its container parts the rows.
<ul class="k2b-divided">{rows}</ul>

// A reading column's views and actions float in the pill.
<FloatingPill label="Note views and actions">{controls}</FloatingPill>
```

## Related pages

- [Flat criteria](/en/ui/surfaces/flat-criteria)
- [AppWorkspace](/en/ui/layout/workspace)
- [ResizeSeparator](/en/ui/layout/resize-separator)
- [Colors and selection](/en/ui/surfaces/color)
- [Toolbar](/en/ui/actions/toolbar)
