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
- A page that scrolls sideways.

It does not see what runs out of the bottom of a scroll area or what a floating
layer covers. A review of screenshots checks those.

## Import

```ts
import { layoutProblems, type LayoutProblemOptions, type LayoutProblems } from "@k2b/ui/layout-check";
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

It returns `overlap`, `spill`, `cut`, and `double` as lists of readable lines,
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
