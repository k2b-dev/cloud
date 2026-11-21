# Flat criteria

Cloud flach is the shared look of every Cloud screen: hairlines instead of
shadows, square bands and rows, round controls, fixed heights, and one place for
each kind of message. Seventeen criteria (K1 to K17) describe it. Each criterion
is either **measure**, which a check or test proves, or **judgement**, which a
review answers with the question given here. A pull request that changes UI
answers the judgement questions in its description.

The criteria replace the island model of [Layers and shadows](/en/ui/surfaces/elevation).
Building blocks move to them one by one; until a page says otherwise, its old
contract still describes what ships.

## Use the criteria

Pick the building block, not the look. A page is made of these blocks; their
heights, lines, and radii follow from the tokens below.

| Building block | What it is |
| --- | --- |
| **status row** | The first row under a column's head, 52 px: the lead statement (18 px, bold), at most three key figures, filters on the right. Selection and page state take the place of the figures. |
| **notice cell** | A square cell in the state colour where the thing is: sign, sentence, consequence, and a button that names the deed. Never a round box inside a cell. |
| **section header** | The head of one topic: an icon in a 20 px tile in the colour of its area, a 13 px bold title, a count, at most two grey text buttons. |
| **group** | Sorts the rows of a list by one property. 36 px head on the quiet page surface, 13 px bold name, count, at most one action. Disappears when empty. |
| **area** | A thing the rows belong to, such as a stack with its lists. Its own square surface, 56 px head with two lines, a rail from head to last row, 8 px between areas. |
| **facts group** | A group of labelled values in the facts column: quiet label, strong value, an icon, one pencil per group. |
| **resize grip** | The 5 × 32 px round grey mark in the middle of a draggable edge. Only such an edge has it. |
| **path header** | A head that shows a path instead of tabs; the view switch is a segment on the right. |
| **floating pill** | Views and actions over reading text that has no head, fully round, with the small overlay shadow. |

## Criteria

| | Criterion | Kind | Check or question |
| --- | --- | --- | --- |
| K1 | Fixed heights and one spacing scale: head 56, status row 52, column head 36, rows 40/52/72, dense 32; phone title 52, tabs 44, row 60; gaps 4, 8, 12, 16, 20, 24, 32 px | measure | the `--k2b-h-*` and `--k2b-space-*` tokens; height tests of each building block |
| K2 | Hairlines divide: 1 px, one colour, edge to edge of their column; the head line carries the 2 px tab mark | measure | `shadow-tokens` (no column shadow), the workspace hairline browser test |
| K3 | Shadows only for what floats | measure | `shadow-tokens` |
| K4 | Round is what you press, square is what orders: 0, 4, 8, 14 px, or round | measure | `radius-scale` |
| K5 | Alignment: text edge 20 px (phone 16 px), fields of three fixed lines on one grid, numbers right-aligned in tabular figures | measure | `field-subgrid.browser.test.ts` |
| K6 | Head shows tabs or a path, never both; the status row holds the lead statement | judgement | Is the lead statement what a person wants to know here first? |
| K7 | Table and list: grey 12 px column head without fill, lines under rows only, selection is a fill in the app colour, name column at most 560 px | measure | `layoutProblems`, `DataTable` browser tests |
| K8 | Colour only with meaning: grey carries, app colour is "you are here", blue is "you press this", green, yellow, and red are states with a word, plum is AI | judgement | Does every colour on the page map to one of these meanings? |
| K9 | The detail column: docked, 380 px, head 56 px, sections divided by hairlines, icons on one axis | measure | `workspace-surfaces`, detail browser tests |
| K10 | Notice and fault: a page-wide fault rests in the status row; what needs a person is a notice cell where the thing is; empty is a sign, a sentence, and a way out, without a box | measure, judgement | `notice-cards`; Does it concern the page or one thing? Must someone act? |
| K11 | Four sizes in the controls: 12, 13, 14, 18 px; three weights | measure | `type-scale.browser.test.ts` |
| K12 | Phone below 768 px, tablet to 1023 px, wide from 1920 px | judgement | Does every width look intended? (`host-breakpoints` and `layoutProblems` at 390 and 768 px measure the rest) |
| K13 | A draggable edge carries a grip, and no other edge does | measure | `resize-grips` |
| K14 | No needless nesting: a square area with one framed child loses the inner frame | measure | `workspace-surfaces`, `notice-cards` |
| K15 | Overflow and wrapping: one behaviour per kind of content; nothing overlaps, spills, or is cut without a sign | measure | `layoutProblems` at 390, 768, 1440, and 1920 px |
| K16 | Overlays: menus, toasts, and pills small shadow; dialog large shadow over a 28 % scrim; no blur | measure | `glass-surfaces`, `shadow-tokens` |
| K17 | Dense detail pages: three type steps, order "who, what now, domain, holdings, history", group or area below a section | measure, judgement | the area browser test; Do you find within five seconds what to do and how much money flows? |

### Group and area

An app knows two levels below a section and invents no third. Use an **area**
when it exists while empty, has a state of its own, or has two or more actions
of its own; otherwise use a **group**. An area holds rows or one more area,
never groups.

A collapsed area is a row: 40 px high like a list row, with name, state, count,
and a chevron, without the 8 px gap and without a surface of its own. Open, it
is the full area with its 56 px head, its own square surface, and its rail.
Only the person switches between the two; nothing else makes it jump.
**Measure:** collapsed height equals the row height, in the browser test of the
building block "area".

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| `--k2b-space-1` … `-8` | 4, 8, 12, 16, 20, 24, 32 px | every gap |
| `--k2b-gutter` | 20 px, 16 px below 768 px | the text edge of a column (`--k2b-edge` is the colour of a control's edge) |
| `--k2b-h-head`, `-status`, `-colhead` | 56, 52, 36 px | head, status row, column head |
| `--k2b-h-row`, `-row-2`, `-row-3`, `-row-dense` | 40, 52, 72, 32 px | rows of one, two, three lines; dense rows |
| `--k2b-h-label`, `-control` | 20, 36 px | field label, control |
| `--k2b-h-area-head`, `-group-head` | 56, 36 px | area and group heads |
| `--k2b-h-head-phone`, `-tabs-phone`, `-row-phone` | 52, 44, 60 px | phone |
| `--k2b-font-size-meta`, `-row`, `-body`, `-lead` | 12, 13, 14, 18 px | the four sizes |
| `--k2b-radius-flat`, `-mark`, `-control`, `-overlay`, `-round`, `-card` | 0, 4, 8, 8 px, round, 14 px | the radius roles; `--k2b-radius-surface` and `-dialog` are the overlay role |
| `--k2b-shadow-overlay-sm`, `-overlay-lg` | small, large | menu, popover, toast, pill, drag preview; dialog |
| `--k2b-shadow-side`, `-sheet` | directed | drawer, phone sheet |
| `--k2b-scrim` | 28 % | behind a dialog or sheet, without blur |

The layer tokens of things that never float (`--k2b-shadow-surface`, `-raised`,
`-frame`, the island hook `--k2b-island-shadow`) draw nothing. They stay as
names; outside `@k2b/ui` a use of one, or of the column tokens
`--k2b-shadow-column-*`, is a `shadow-tokens` finding. The column shadow itself
goes when the workspace draws its hairline (K2).

Checks with a baseline (`radius-scale`, `resize-grips`, `shadow-tokens`,
`glass-surfaces`, `notice-cards`) list today's known findings in
`scripts/checks/<rule>.baseline`, one line each. A new finding fails; a fixed one
is removed with `bun scripts/check.ts <rule> --fix`.

## Import

The tokens ship in `@k2b/ui/styles.css` on every `.k2b-ui` scope; the building
blocks come from the package root:

```tsx
import { AppWorkspace, DataTable, NoticeCard, ResizeSeparator, Section } from "@k2b/ui";
```

## Accessibility

A shadow or a radius never carries meaning alone: focus, selection, and state
show through fill, edge, and a word. A notice cell names its deed in the button.
A resize grip is a `role="separator"` with its value range, a name, and arrow
keys ([ResizeSeparator](/en/ui/layout/resize-separator)).

## Runtime

The criteria are CSS tokens and building blocks; they render on the server and
need no browser code. In a browser test, call `layoutProblems` from
`packages/ui/test/head-overlap.ts` with `page.evaluate`, once per width in its
own test.

## Example

```css
/* An app-owned row in a list: a square row on a hairline, a round chip. */
.parcel-row {
  min-height: var(--k2b-h-row);
  padding-inline: var(--k2b-gutter);
  border-bottom: 1px solid var(--k2b-border);
  border-radius: var(--k2b-radius-flat);
}
.parcel-row__state {
  border-radius: var(--k2b-radius-round);
  font-size: var(--k2b-font-size-meta);
}
/* Something that floats: the small overlay shadow and the overlay radius. */
.parcel-menu {
  border-radius: var(--k2b-radius-overlay);
  box-shadow: var(--k2b-shadow-overlay-sm);
}
```

## Related pages

- [Layers and shadows](/en/ui/surfaces/elevation)
- [Colors and selection](/en/ui/surfaces/color)
- [ResizeSeparator](/en/ui/layout/resize-separator)
- [Workspace](/en/ui/layout/workspace)
