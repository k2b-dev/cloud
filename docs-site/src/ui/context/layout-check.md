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
- A scroll container that scrolls sideways, such as a detail panel body whose
  content is a few pixels too wide. A box with only `overflow-y: auto` counts
  too, because the browser makes its `overflow-x` auto as well.
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

## Import

```ts
import {
  classicScrollbars,
  layoutProblems,
  layoutWidths,
  scrollbarWidth,
  type LayoutProblemOptions,
  type LayoutProblems,
} from "@k2b/ui/layout-check";
```

`layoutWidths` is the list of widths every page test checks: 390, 768, 1100,
and 1440 px. At 1100 px a docked detail column leaves the least room, so test
it with the detail column open. `classicScrollbars` holds the launch options
for visible scrollbars, and `scrollbarWidth()` measures in the page how much
room a scrollbar takes.

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

A scroller that is meant to scroll sideways, such as a row of chips, says so
with `data-layout-check="scroll-x"`. A code block (`pre`) keeps its lines and
may scroll sideways. A toolbar (`role="toolbar"`) may scroll sideways below
768 px, because on a phone its tools scroll instead of moving into "⋯".
Everywhere else, a sideways scroller is a finding.

It returns `overlap`, `spill`, `cut`, `scroll`, `double`, and `scrollbar` as lists of readable lines,
`sideways` as a boolean, and `problems` as every problem in one list. If the
page is clean, `problems` is empty. To skip a box, give it
`data-layout-check="skip"`. A visually hidden box, 1 px and clipped like
`k2b-sr-only`, keeps its content for screen readers on purpose; the check skips
it and everything inside it.

## Run with classic scrollbars

Headless Chromium hides scrollbars by default, so a scrollbar never takes
space in a test. On most desktops it does: a list that is exactly as wide as its
column then scrolls sideways by the scrollbar's width. Launch the browser with
classic scrollbars for page tests:

```ts
import { classicScrollbars, scrollbarWidth } from "@k2b/ui/layout-check";

const browser = await chromium.launch(classicScrollbars);
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
expect(await page.evaluate(scrollbarWidth)).toBeGreaterThan(0);
```

Use narrow desktop windows without touch for this run. With `isMobile` or
`hasTouch`, Chromium draws overlay scrollbars that take no room, even with
`classicScrollbars`. Such a run looks green and measures nothing. Check that
`scrollbarWidth()` is above 0, and test touch in a separate run.

## Example: a page test at four widths

```ts
import { expect, test } from "@playwright/test";
import { classicScrollbars, layoutProblems, layoutWidths } from "@k2b/ui/layout-check";

test.use({ launchOptions: classicScrollbars });

for (const width of layoutWidths)
  test(`${width} px: nothing overlaps, spills, or is cut`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(width >= 1100 ? "/records/2611?detail=open" : "/records/2611");
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
