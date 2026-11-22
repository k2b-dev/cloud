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
| **section header** | The head of one topic: an icon in a 20 px tile in the area colour the app passes, a 14 px bold title (13 px in the detail column, K9), a count, at most two grey text buttons. |
| **group** | Sorts the rows of a list by one property. 36 px head on the quiet page surface, 13 px bold name, count, at most one action. Disappears when empty. |
| **area** | A thing the rows belong to, such as a stack with its lists. Its own square surface, 56 px head with two lines, a rail from head to last row, 8 px between areas. |
| **facts group** | A group of labelled values in the facts column: quiet label, strong value, an icon, one pencil per group. |
| **resize grip** | The 5 × 32 px round grey mark in the middle of a draggable edge. Only such an edge has it. |
| **path header** | A head that shows a path instead of tabs; the view switch is a segment on the right. |
| **floating pill** | Views and actions over reading text that has no head, fully round, with the small overlay shadow. |

## Criteria

| | Criterion | Kind | Check or question |
| --- | --- | --- | --- |
| K1 | Fixed heights and one spacing scale: head 56, status row 52, column head 36, rows 40/52/72, dense 32; phone title 52, tabs 44, row 60; gaps 4, 8, 12, 16, 20, 24, 32 px | measure | the `--k2b-h-*` and `--k2b-space-*` tokens; height tests of each building block as it moves (planned) |
| K2 | Hairlines divide: 1 px, one colour, edge to edge of their column; the head line carries the 2 px tab mark | measure | `border-ownership`, `layoutProblems` (double line), `shadow-tokens`; a workspace hairline browser test with the workspace building block (planned) |
| K3 | Shadows only for what floats | measure | `shadow-tokens` |
| K4 | Round is what you press, square is what orders: 0, 4, 8, 14 px, or round | measure | `radius-scale` |
| K5 | Alignment: text edge 20 px (phone 16 px), fields of three fixed lines on one grid, numbers right-aligned in tabular figures | measure | `field-subgrid.browser.test.ts` |
| K6 | Head shows tabs or a path, never both; the status row holds the lead statement | judgement | Is the lead statement what a person wants to know here first? |
| K7 | Table and list: grey 12 px column head without fill, lines under rows only, selection is a fill in the app colour, name column at most 560 px | measure | `layoutProblems`, `DataTable` browser tests |
| K8 | Colour only with meaning: grey carries, app colour is "you are here", blue is "you press this" and, as a tint, "your turn", green, yellow, and red are states with a word, plum is AI; one filled main action per view | judgement | Does every colour on the page map to one of these meanings? |
| K9 | The detail column: docked, 380 px, head 56 px, sections divided by hairlines, icons on one axis | measure | `workspace-surfaces`, detail browser tests |
| K10 | Notice and fault: a page-wide fault rests in the status row; what needs a person is a notice cell where the thing is; empty is a sign, a sentence, and a way out, without a box | measure, judgement | `notice-cards`; Does it concern the page or one thing? Must someone act? |
| K11 | Four sizes in the controls: 12, 13, 14, 18 px; three weights | measure | `type-scale.browser.test.ts` |
| K12 | Phone below 768 px, tablet to 1023 px, wide from 1920 px | judgement | Does every width look intended? (`host-breakpoints` and `layoutProblems` at 390 and 768 px measure the rest) |
| K13 | A draggable edge carries a grip, and no other edge does | measure | `resize-grips` |
| K14 | No needless nesting: a square area with one framed child loses the inner frame | measure | `workspace-surfaces`, `notice-cards` |
| K15 | Overflow and wrapping: one behaviour per kind of content; nothing overlaps, spills, is cut without a sign, or draws a double line | measure | `layoutProblems` at 390, 768, 1100, 1280, 1440, and 1920 px, with the detail open and with a narrow reader |
| K16 | Overlays: menus, toasts, and pills small shadow; dialog large shadow over a 28 % scrim; no blur | measure | `glass-surfaces`, `shadow-tokens` |
| K17 | Dense detail pages: three type steps, order "who, what now, domain, holdings, history", group or area below a section | measure, judgement | a browser test of the area building block (planned); Do you find within five seconds what to do and how much money flows? |

### One line, one owner (K2)

> „Das größte Risiko bei dem neuen Design sehe ich, dass irgendwelche Borders
> doppelt sind, weil sowohl die obere als auch die untere oder die linke als
> auch die rechte Komponente die Border zeichnet. Das darf nicht passieren, das
> sieht extrem buggy aus und verschiebt alles.“ (Valentin, 21 November 2026:
> the biggest risk is a border drawn twice, because both neighbours draw it.)

Every line has exactly one owner:

- **The container draws the dividers between its children**, with one
  mechanism: the class `k2b-divided` (a 1 px hairline above every shown child
  after the first) or `k2b-divided-inline` for a row (at the start of each
  child). Rows, sections, bands, head and status row, and lists use it or their
  container does.
- **A component draws no outer edge of its own.** Only elements that are framed
  by definition do: field, button, card (K17), overlay, chip, and area. A framed
  element never stands edge to edge in a container with hairlines.
- **Columns:** the line between two columns belongs to the column boundary (the
  divider or the grip of K13). Neither column draws it.
- **Head line and tab mark:** the line under the head belongs to the head. The
  2 px tab mark lies on it and is no second line.
- **Exception, the way:** the line between the dots of `ProgressPath` is the
  only line that divides nothing. It connects the stages of one thing, so the
  path draws it itself: 2 px in the colour of a field edge, never as a border.

**Measure:** `layoutProblems` reports a double line: two parallel visible
borders that touch or lie at most 1 px apart, also across components (the
bottom of A and the top of B, the right of A and the left of B, a parent's and
a child's border on the same edge). Focus rings and outlines do not count. The
`border-ownership` check reports a new outer border on a component root in
`@k2b/ui` and on a root element in an app, outside the framed elements.

```tsx
<ul class="k2b-divided">
  <li>Palette 14</li>
  <li>Palette 15</li>
</ul>
```

### Decisions of 21 November 2026

These four decisions hold for every app and refine K6, K8, K10, and K17.

- **Your turn (K8, K10, K17):** what waits for the person is a blue-tinted cell
  or a blue-tinted chip. Amber means only "to clarify".
- **Violet is not plum (K8):** plum is only AI and Gustav. Violet stays a colour
  with its own meaning, such as a direction pill, also next to plum. No rule
  and no check forbids violet beside plum; the tokens keep the two apart.
- **Area colours belong to the app (K17):** there is no fixed palette of area
  colours. A section header takes the colour the app passes.
- **Main action (K6, K8):** it stands in the head, and may also stand as a
  quiet, unfilled entry in the sidebar where people know it ("Create",
  "Upload"). Each view keeps exactly one filled main button.

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
building block "area" (planned with the building block).

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| `--k2b-space-1`, `-2`, `-3`, `-4`, `-5`, `-6`, `-8` | 4, 8, 12, 16, 20, 24, 32 px | every gap |
| `--k2b-gutter` | 20 px, 16 px below 768 px | the text edge of a column (`--k2b-edge` is the colour of a control's edge) |
| `--k2b-h-head`, `-status`, `-colhead` | 56, 52, 36 px | head, status row, column head |
| `--k2b-h-row`, `-row-2`, `-row-3`, `-row-dense` | 40, 52, 72, 32 px | rows of one, two, three lines; dense rows |
| `--k2b-h-label`, `-control` | 20, 36 px | field label, control |
| `--k2b-h-area-head`, `-group-head` | 56, 36 px | area and group heads |
| `--k2b-h-head-phone`, `-tabs-phone`, `-row-phone` | 52, 44, 60 px | phone |
| `--k2b-font-size-meta`, `-row`, `-body`, `-lead` | 12, 13, 14, 18 px | the four sizes |
| `--k2b-radius-flat`, `-mark`, `-control`, `-overlay`, `-round`, `-card` | 0, 4, 8, 8 px, round, 14 px | the radius roles; `--k2b-radius-dialog` is the overlay role; `--k2b-radius-surface` keeps 12 px until its users move to a role |
| `--k2b-radius-tile` | 8 px | an icon tile; a tile below 24 px sets `--k2b-radius-mark` |
| `--k2b-shadow-overlay-sm`, `-overlay-lg` | small, large | menu, popover, toast, pill, drag preview; dialog |
| `--k2b-shadow-side`, `-sheet` | directed | drawer, phone sheet |
| `--k2b-shadow-frame` | a 1 px ring | the edge of the app card, no shadow |
| `--k2b-scrim` | 28 % | behind a dialog or sheet, without blur |

The layer tokens of things that never float (`--k2b-shadow-surface`, `-raised`,
the island hook `--k2b-island-shadow`) draw nothing; `--k2b-shadow-frame` is only
the app card's hairline edge. They stay as
names; outside `@k2b/ui` a use of one, or of the column tokens
`--k2b-shadow-column-*`, is a `shadow-tokens` finding. The column shadow itself
goes when the workspace draws its hairline (K2).

Checks with a baseline (`border-ownership`, `radius-scale`, `resize-grips`,
`shadow-tokens`, `glass-surfaces`, `notice-cards`, `layout-check-coverage`) list today's known findings in
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

## Test a page

Every app lane tests each page it builds this way. This rule is binding:

- **Widths:** 390, 768, 1100, and 1440 px (`layoutWidths`), each width in its
  own test. 1100 px is where a docked detail column leaves the least room.
- **Detail column at 1100 px:** the detail column is open, so the list, the
  reader, and the detail stand side by side.
- **Visible scrollbars:** the browser runs with classic scrollbars
  (`launchWithScrollbars()` in this repository, `classicScrollbars` from
  `@k2b/ui/layout-check` elsewhere). A hidden scrollbar takes no width, so a
  column that is a few pixels too wide never scrolls sideways in a test.
- **Desktop windows without touch for that run:** with `isMobile` or
  `hasTouch`, Chromium draws overlay scrollbars that take no room, even with
  classic scrollbars. The run checks `scrollbarWidth()` above 0, so it measures
  what it claims. Touch is a separate run.
- **Check:** `layoutProblems` finds overlap, spill, cut text, a double line, a
  scroll container that scrolls sideways, and a page that scrolls sideways.
  `problems` is empty at every width.

The `layout-check-coverage` rule fails a browser test that calls
`layoutProblems` without visible scrollbars, without the `scrollbarWidth`
probe, or without 1100 px. Tests that
existed before the rule are listed in its baseline until they move.

```ts
import { layoutWidths, scrollbarWidth } from "@k2b/ui/layout-check";
import { launchWithScrollbars } from "../../test/browser";

const browser = await launchWithScrollbars();
// A narrow desktop window without touch; a scrollbar must take room here.
expect(await page.evaluate(scrollbarWidth)).toBeGreaterThan(0);
for (const width of layoutWidths)
  test(`${width} px: the record page has no layout problem`, async () => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(width >= 1100 ? "/records/2611?detail=open" : "/records/2611");
    expect((await page.evaluate(layoutProblems, { root: "main" })).problems).toEqual([]);
  });
```

## Runtime

The criteria are CSS tokens and building blocks; they render on the server and
need no browser code. In a browser test, call `layoutProblems` from
`@k2b/ui/layout-check` with `page.evaluate`, once per width in its own test.

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
