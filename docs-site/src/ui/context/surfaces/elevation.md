# Layers and shadows

Every Cloud screen has four layers. A shadow appears only where one layer lies
on another, never inside a layer, and never as depth inside depth. Components
choose their layer by default and by where they sit, so an application, a
built-in app, and a third-party app get the same result without choosing a
shadow.

**The rule in one sentence:** a content card with its own content block (a
title, meta, a price, a link) in the main content is an island with a soft
shadow; everything else is flat.

## Use the four layers

| Layer | What lies there | Shadow |
| --- | --- | --- |
| 0 Workspace | The app card and its columns: sidebar, main content, docked detail panel | The app card: `--k2b-shadow-frame`. Columns: the quiet column shadow. Inside: flat. |
| 1 Islands | Content cards in the main content: `Paper`, a framed `Section`, `LinkCard`, `ResourceCard`, `DashboardFrame`, `DashboardPanel`, a `StatCell` tile, a Kanban card | `--k2b-shadow-raised` with a light 1 px edge. Dark mode: a lighter surface instead. |
| 2 Overlaying | Surfaces that cover content: a drawer, a sheet, a `PanelDialog`, the detail panel as a sheet on a phone | `--k2b-shadow-side`, `--k2b-shadow-sheet`. Inside: flat. |
| 3 Floating | Menus, popovers, dialogs, tooltips, hover previews, toasts, drag previews; floating pills and toolbars | `--k2b-shadow-float`, `--k2b-shadow-toast`; pills and toolbars `--k2b-shadow-toolbar`. Inside: flat. |

"Surfaces with shadows" is the default for everyone. There is no setting.

## Island or flat

An **island** is a content card with its own content block, in the main
content:

- a framed `Section` on a full page, such as the topics of a contact or a
  customer file;
- a Kanban card, a storage card (Files), a resource card in a chat message, an
  AI card, a dashboard frame, an overview `LinkCard`.

A **dense collection** stays **flat**, also with pictures. Selection shows as a
fill and an edge, never as a shadow:

- file and media grids (`FileGrid`, photo galleries) and attachments;
- text lists and rows: the mail list, file rows, table rows, sidebar items,
  calendar events, chat bubbles.

**Controls never cast a shadow.** Buttons, fields, chips, tabs, segments,
switches, and toggles have the 2 px edge and change only colour and fill
([Colors and selection](/en/ui/surfaces/color#field-edge)).

**Columns, panels, sheets, dialogs, and menus are flat inside:** a header,
space, and at most a hairline. A `DetailPanel` is a docked column (layer 0),
so its sections are a header and a hairline, never cards.

**No depth inside depth.** Everything inside an island is flat: a `Paper` in
a `Paper`, a table in a `DashboardFrame`, a card in a `Section`.

### Do and don't

| Do | Don't |
| --- | --- |
| Put each topic of a full page in a framed `Section`; it gets the island shadow. | Draw a shadow under a list row, a table row, or a file tile. |
| Let the file grid stay flat and show selection as fill and edge. | Give an image tile a shadow because it shows a picture. |
| Keep a detail panel flat: sections with a header and a hairline. | Put shadowed cards inside a panel, a sheet, or a dialog. |
| Float a toolbar that stays open with `Toolbar variant="floating"`. | Give a pill the menu shadow, or invent a shadow for it. |
| Fade overflowing text with a mask to the surface. | Fade with a dark inner shadow ("a bulge"). |
| Use glass only for a layer over a picture, video, or map. | Put glass over text that scrolls beneath it. |

## Tokens

Use only these tokens. The repository rule `shadow-tokens` rejects any other
shadow with a blur in packages and apps; rings and hairlines (blur 0, such as
`inset 0 0 0 2px`) are edges and stay allowed.

| Token | Light | Dark | For |
| --- | --- | --- | --- |
| `--k2b-island-shadow` | `--k2b-shadow-raised` in the main content, no shadow in a flat layer | no shadow | Read this in every island. Never set a value yourself. |
| `--k2b-island-surface` | `--k2b-surface-raised` in the main content, `--k2b-surface` in a flat layer | same | The background of an island. |
| `--k2b-surface-beneath` | set inside an island to its surface | same | Mix a fill into what lies below it (a selected row) with `var(--k2b-surface-beneath, var(--k2b-surface))`; fields and controls keep `--k2b-surface`. |
| `--k2b-shadow-raised` | `0 1px 2px rgb(15 23 19 / .05), 0 4px 12px -6px rgb(15 23 19 / .12)` | no shadow | Layer 1, through the island hook. |
| `--k2b-surface-raised` | `--k2b-surface` | `--k2b-surface-elevated` | The lighter island surface in dark mode. |
| `--k2b-shadow-toolbar` | `0 1px 2px rgb(9 9 11 / .06), 0 6px 18px -8px rgb(9 9 11 / .16)` | `0 1px 2px rgb(0 0 0 / .4), 0 8px 22px -10px rgb(0 0 0 / .5)` | Floating pills and toolbars that stay open. |
| `--k2b-shadow-frame` | unchanged | unchanged | The app card on the canvas; standalone pages (`Paper elevated`). |
| `--k2b-shadow-side`, `--k2b-shadow-sheet` | unchanged | unchanged | Drawers, sheets, `PanelDialog`. |
| `--k2b-shadow-float`, `--k2b-shadow-toast` | unchanged | unchanged | Menus, popovers, dialogs, hover previews, toasts, drag previews. |

A floating toolbar that stays open is softer than a menu that opens for a
moment, so pills never share `--k2b-shadow-float`.

"No shadow" is a transparent no-op layer (`0 0 #0000`), never `none`, so a
ring and the island hook can share one list:
`box-shadow: inset 0 0 0 1px var(--edge), var(--k2b-island-shadow)`.

## Dark mode

In dark mode an island has no shadow: `--k2b-surface-raised` makes it one
step lighter than the main content. Overlaying and floating layers keep their
dark shadows. An island inside an island takes the same surface, so the pair
reads as one plane.

## Glass

Glass (`k2b-overlay-surface`) stays the one exception, for a floating layer
over a picture, video, or map. It uses `--k2b-overlay-lift`. A toolbar over a
document is solid, so text that scrolls beneath it never shows through.

## Floating pills

`Toolbar variant="floating"` is a pill: fully rounded, a light 1 px edge,
`--k2b-shadow-toolbar`, 44 px controls. It floats at the bottom of its column,
and content scrolls beneath it but still ends above it, so the last line stays
reachable.

For two pills at the edges of one column, such as formatting at the left and
comments, reading, and details at the right, put both into one `ToolbarDock`
(see the example below). Each pill moves its own lower-priority actions into
More when the row gets narrow.

## Fades

Scroll and hover fades always end in the surface colour, through a mask:
`data-scroll-fade`, `ScrollArea`, or the content's own `mask-image`. A dark
inner shadow as a fade is never used. `HoverPreview` floats on layer 3 with
`--k2b-shadow-float` outside and no inner shade.

## How an app gets it for free

- **Use the components.** `Paper`, `Section`, `LinkCard`, `ResourceCard`,
  `DashboardFrame`, `DashboardPanel`, `StatCell`, `DataTable.Panel`, and the widgets are islands in the main
  content and flat everywhere else. `DetailPanel`, `AppWorkspace` columns,
  sheets, dialogs, popovers, menus, and toolbars make their inside flat.
- **Mark a dense collection.** Put `data-k2b-layer="flat"` on the element that
  holds a grid or a list of cards that must stay flat.
- **An app-owned card** that no component expresses, such as a Kanban card,
  reads the hook: `box-shadow: var(--k2b-island-shadow)` and
  `background: var(--k2b-island-surface)`. It then follows every layer and
  theme like a `Paper`.
- **In Cloud**, the `paper` utility class reads the same hook, and the side
  panel (help, Assistant, chat) is flat inside.
- **A justified exception** names its reason in a comment on the line above:
  `/* shadow-tokens: allow <reason> */` (or `{/* … */}` in JSX). An example
  is a resize handle on a photo, which needs a halo on any picture.

## Import

The tokens and the layer rules ship in `@k2b/ui/styles.css` below the nearest
`.k2b-ui` scope. The components that choose a layer come from the package
root:

```tsx
import { LinkCard, Paper, ResourceCard, Toolbar, ToolbarDock } from "@k2b/ui";
```

## Accessibility

A shadow is never the only signal. Every island keeps its light 1 px edge,
which stays visible in forced colours, where shadows disappear. Selection,
focus, and errors show through fill, edge, and text, never through depth.
Floating pills keep 44 px touch targets, and the content end stays reachable
above them for keyboard and screen reader users.

## Runtime

Layers are CSS only: custom properties that each layer sets for its inside.
They render on the server and need no browser code, so the first paint
already shows the final depth. Dark mode switches with the theme of the
`.k2b-ui` scope.

## Example

```tsx
// Main content: islands get the shadow by default.
<Paper as="section" class="contact-topic">
  <h2>Reachable</h2>
  <p>+49 8142 555 0182</p>
</Paper>

// A dense collection stays flat.
<div class="photo-grid" data-k2b-layer="flat">{tiles}</div>

// An app-owned card reads the island hook.
.board-card {
  border: 1px solid var(--k2b-border);
  background: var(--k2b-island-surface);
  box-shadow: var(--k2b-island-shadow);
}

// Two pills at the edges of one column.
<ToolbarDock>
  <Toolbar label="Formatting" variant="floating">
    <Toolbar.Action label="Bold" icon="ti ti-bold" priority={1} />
    <Toolbar.Action label="List" icon="ti ti-list" priority={2} />
  </Toolbar>
  <Toolbar label="Page" variant="floating">
    <Toolbar.Action label="Comments" icon="ti ti-message" />
    <Toolbar.Action label="Details" icon="ti ti-info-circle" />
  </Toolbar>
</ToolbarDock>
```

## Related pages

- [Paper](/en/ui/surfaces/paper)
- [Colors and selection](/en/ui/surfaces/color)
- [DetailPanel](/en/ui/layout/detail-panel)
- [Toolbar](/en/ui/actions/toolbar)
- [HoverPreview](/en/ui/feedback/hover-preview)
