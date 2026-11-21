# Paper

`Paper` provides a neutral frame for content on a full page: a 1 px hairline,
square corners, the page surface, and no shadow. An interactive `Paper` is a
card with 8 px corners. The application owns spacing and layout.

## Use Paper

Use `Paper` when related content needs one visible boundary and no more
specific `@k2b/ui` component owns the group. Prefer `DataPanel` for records,
`LinkCard` for a single navigation destination, `NoticeCard` for a persistent
finding, and `PanelDialog` for dialog geometry.

Do not nest papers to manufacture hierarchy. Use spacing, headings, or one of
the specific shared components inside the outer surface instead.

`Paper` is flat in every layer (Cloud flat, K2 to K4): only what lies above the
page, such as a menu, a dialog, or a toast, casts a shadow. Structure is square;
only what people press is round. Never add a shadow or a radius of your own.
Clickable `Paper` with `interactive` is a card for one of several independent
things side by side (K17): flat, a 1 px border, 8 px corners, never nested and
never the frame of a section.

`elevated` stays for a standalone page card, such as a sign-in or a shared
document page, that sits on the canvas like the app card. It reads the frame
shadow token, which the flat design sets to none; it does not change the
border, radius, or content spacing.

`Paper` has no default padding. This lets the content owner choose its density
without overriding the surface contract.

Inside `AppWorkspace.Main`, empty, error, and loading placeholders draw no
Paper box. A workspace view such as a list, a board, or a table stays one
surface without inset frames, and a `DataTable` there uses `surface="plain"`.
A page with several topics frames each topic once with a hairline. See
[UI-22](/en/docs/conventions/frontend#visual-ui-ui).

## Import

```tsx
import { Paper } from "@k2b/ui";
```

## Properties

| Property | Type | Default | Purpose |
| --- | --- | --- | --- |
| `as` | `"div" \| "section" \| "article" \| "a"` | `"div"` | Preserves the native meaning of the grouped content. |
| `elevated` | `boolean` | `false` | Reads the frame shadow token for a standalone page card on the canvas. |
| `interactive` | `boolean` | `false` | Makes it a card: 8 px corners, a stronger border, the shared hover and visible focus treatment. |
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
