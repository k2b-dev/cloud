# Paper

`Paper` provides a neutral content surface with a border, radius, background,
optional elevation and optional interactive focus treatment. The application
owns spacing and layout.

## Use Paper

Use `Paper` when related content needs one visible boundary and no more
specific `@k2b/ui` component owns the group. Prefer `DataPanel` for records,
`LinkCard` for a single navigation destination, `NoticeCard` for a persistent
finding, and `PanelDialog` for dialog geometry.

Do not nest papers to manufacture hierarchy. Use spacing, headings, or one of
the specific shared components inside the outer surface instead.

`Paper` is an island ([Layers and shadows](/en/ui/surfaces/elevation)). In the
main content it carries the soft island shadow (`--k2b-shadow-raised`; in dark
mode a lighter surface instead). In a flat layer, such as an `AppWorkspace`
sidebar or detail column, a `DetailPanel`, a dialog, a sheet, a popover, or an
element with `data-k2b-layer="flat"`, it is flat. A Paper inside another island
is flat too. Never add a shadow of your own.

Set `elevated` only for a standalone page card, such as a sign-in or a shared
document page, that sits on the canvas like the app card. It uses the frame
shadow; it does not change the border, radius, or content spacing.

`Paper` has no default padding. This lets the content owner choose its density
without overriding the surface contract.

Inside `AppWorkspace.Main`, empty, error, and loading placeholders draw no
Paper box. A workspace view such as a list, a board, or a table stays one
surface without inset frames, and a `DataTable` there uses `surface="plain"`.
A page with several topics frames each topic once, as an island. See
[UI-22](/en/docs/conventions/frontend#visual-ui-ui).

## Import

```tsx
import { Paper } from "@k2b/ui";
```

## Properties

| Property | Type | Default | Purpose |
| --- | --- | --- | --- |
| `as` | `"div" \| "section" \| "article" \| "a"` | `"div"` | Preserves the native meaning of the grouped content. |
| `elevated` | `boolean` | `false` | Uses the frame shadow for a standalone page card on the canvas. |
| `interactive` | `boolean` | `false` | Adds the shared hover and visible focus treatment. |
| `class` | `string` | none | Adds application-owned spacing or layout. |
| `children` | `JSX.Element` | none | Renders the grouped content. |

The selected native element also accepts its normal HTML attributes, such as
`href` on an anchor.

## Accessibility

Choose `as` from the content's meaning. Use `section` only when the content has
a heading, `article` for a self-contained item, and `a` only when the complete
surface leads to one destination.

`interactive` changes presentation, not semantics or behavior. It does not
make a `div`, `section`, or `article` clickable. Use a native anchor for
navigation and a shared button component for actions.

## Runtime

`Paper` renders on the server and requires no browser state. An anchor works
without browser code. Its appearance comes from `@k2b/ui/styles.css` below the
nearest `.k2b-ui` scope.

`LinkCard`, `DataPanel`, `DataTable.Panel`, paper placeholders, statistics,
tables, and widgets reuse this same surface contract internally.

## Example

```tsx
<Paper as="section" class="project-summary">
  <h2>Project summary</h2>
  <p>Three services are ready for deployment.</p>
</Paper>

<Paper
  as="a"
  href="/projects/current"
  class="project-summary-link"
  elevated
  interactive
>
  Open the current project
</Paper>
```
