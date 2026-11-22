# Layout self-check

`layoutProblems` checks a rendered page for layout faults in a browser test.
It is the self-check of the flat design rules (overflow and wrapping), the
`?check=1` of the mockups, as one function. Apps outside this repository can
use it with Playwright or any browser test that can run a function in the page.

## What it finds

- Siblings in a flex or grid box that overlap.
- Content that spills out of its box.
- Text that is cut without an ellipsis or a fade.
- A double line: two parallel visible borders that touch or lie at most 1 px
  apart, also across components ("one line, one owner").
- A line break by scrollbar: a head cell that does not stand over its body
  cells within 0.5 px, also when head and body sit in two tables, or a gap
  between neighbouring head cells ("a scrollbar moves nothing").
- A page that scrolls sideways.

It does not see what runs out of the bottom of a scroll area or what a floating
layer covers. A review of screenshots checks those.

A touch hit area is not a spill. On a coarse pointer, small controls reach
44 px with an empty, invisible pseudo-element: `::before` or `::after` with
`content: ""`, absolute or fixed position, and no fill, border, or shadow. The
check ignores overflow that only such hit areas cause, in `@k2b/ui` and in
your own controls, so a page with touch needs no `data-layout-check="skip"`. A
pseudo-element that draws something and reaches past its box still counts.

## The checks of the flat look

Four more kinds measure the flat look against the mockup values. They are off
by default, so a page that passes today keeps passing. Turn them on with
`flat: true`, or name the ones you want, such as `flat: ["short-edge"]`. Their
lines then join `problems`. `ignore` and `data-layout-check="skip"` do not
apply to them.

- `short-edge`: a line or a fill of a row, cell, selection, or notice in a flat
  area stops short of the area's inner edge, or runs past it, by more than
  0.5 px. A line is a border of at most 1 px, a 1 px box-shadow line, or a thin
  pseudo-element; a fill is a background colour with square corners that
  differs from what lies behind it. What a scrolling or clipping box cuts off
  does not count. Lines and fills of one area at the same height count as one run,
  and a run that spans at least half the area must reach both edges. A
  reserved scrollbar gutter is no excuse: lines and fills run under it. Text
  keeps its own inset. Framed elements (round corners, or a border on three
  sides or more), fields, and boxes that float are no rows.
- `near-double`: two parallel lines at most 8 px apart that run side by side
  over at least half of the shorter one, in the same layer (a sheet or dialog
  is a layer of its own). It also sees lines drawn as a box-shadow or a
  pseudo-element, such as the column lines of a workspace, which `double` does
  not. A pair that `double` already reports is not repeated. The edge of a
  frame (round corners, or a border on three sides or more), such as a field,
  button, or card, counts only beside a drawn line: a card on a column line is
  a double line, a card below a row line is not.
- `grip-off-center`: the grip of a `role="separator"` is not centred on the
  line under it within 0.25 px, sits more than 1 px off the middle of that
  line's visible length, has no line under it, has its or its line's edges on
  fractions of a pixel (at a device pixel ratio of 1, where they blur), or is
  painted behind the line or anything else. The check compares stacking contexts and tree order, so it
  also sees a line drawn by a pseudo-element.
- `type-role`: text in a flat area whose font size, line height, and weight
  are no type role. The roles come from the `--k2b-type-roles` token of
  `@k2b/ui`, which derives from the four role tokens
  ([Type roles](./surfaces/utilities#type-roles)). Reading text (Markdown, an editor) and initials in an avatar are
  left out.

A flat area is a column of an `AppWorkspace` (sidebar, main and its panes,
detail, drawer) or any box with `data-layout-area`. Pass `areas` to use other
boxes. The innermost area owns an element.

### Type roles

| Role | Size | Line heights | Weights |
| --- | --- | --- | --- |
| meta | 12 px | 16, 20 px | 400, 500, 600 |
| row | 13 px | 20 px | 400, 500, 600 |
| title | 14 px | 20, 22 px | 400, 600 |
| lead | 18 px | 20, 24 px | 600 |

The values are the computed styles of the approved mockup (Cloud flach,
version 10). The head title and reading text use 14 px, the lead statement
18 px; a phone title sets the lead in a 20 px line.

## Import

```ts
import { type FlatProblemKind, layoutProblems, type LayoutProblemOptions, type LayoutProblems } from "@k2b/ui/layout-check";
```

The subpath is separate from the main entry of `@k2b/ui`. It has no
dependencies and adds nothing to the bundles of an app.

## Contracts

`layoutProblems(options?)` runs in the page. Pass it to `page.evaluate`, so it
uses nothing from outside the function.

| Option | Type | Purpose |
| --- | --- | --- |
| `root` | `string` | A selector for the element to check. The default is the whole document. |
| `ignore` | `string` | A selector for boxes whose children overlap or clip on purpose, such as an avatar stack. |
| `slack` | `number` | How far content may reach past its box before it counts, in px. The default is 7. |
| `flat` | `boolean \| FlatProblemKind[]` | Turns on the checks of the flat look: `true` for all four, or a list of `"short-edge"`, `"near-double"`, `"grip-off-center"`, and `"type-role"`. Off by default. |
| `areas` | `string` | A selector for the flat areas. The default is the columns of every `AppWorkspace` and `[data-layout-area]`. |

It returns `overlap`, `spill`, `cut`, `double`, and `scrollbar` as lists of readable lines,
`shortEdge`, `nearDouble`, `gripOffCenter`, and `typeRole` (empty unless `flat` turns them on),
`sideways` as a boolean, and `problems` as every problem in one list. If the
page is clean, `problems` is empty. To skip a box, give it
`data-layout-check="skip"`. A visually hidden box, 1 px and clipped like
`k2b-sr-only`, keeps its content for screen readers on purpose; the check skips
it and everything inside it.

## Example: a page test at four widths

```ts
import { expect, test } from "@playwright/test";
import { layoutProblems } from "@k2b/ui/layout-check";

for (const width of [390, 768, 1440, 1920])
  test(`${width} px: nothing overlaps, spills, or is cut`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/records/2611");
    expect((await page.evaluate(layoutProblems, { root: "main" })).problems).toEqual([]);
  });
```

Check each width in its own test, so that one failure names its width. Check
the states that change the layout too: an open detail column, a narrow reader,
a long name, an error.

## Rules as lint

The measurable rules (radius scale, shadow tokens, grips on resizable edges)
are repository checks in Cloud, not part of this package. An app can rebuild
them as its own lint rules from the flat design criteria.
