# Progress path

`ProgressPath` shows the way of one thing through its stages: dots on one
line, each stage with a name and a quiet line, such as where an order or a
returned item is on its way. A stage is done, current, or open.

## Use ProgressPath

Use it when one object moves through fixed stages and people need to see which
stages happened and when. It fits a `HoverCard` behind a small glyph, a detail
panel, or a page head. For instructions that people follow, use `Steps`; for
events on a time axis, use `Timeline`.

## Import

```tsx
import { ProgressPath, type ProgressPathStep } from "@k2b/ui";
```

## Contracts

| Prop | Type | Purpose |
| --- | --- | --- |
| `steps` | `readonly ProgressPathStep[]` | The stages in order. |
| `label` | `string` | Accessible name of the list, such as "Path of B7A02". |
| `class` | `string` | Extra class on the root. |

Each step has a `label`, an optional `detail` line such as a day or "not yet",
`done` when it happened, `current` for the one stage the thing is at now, and
an optional Tabler `icon` that an open stage shows in its dot. A done stage
shows a check in a quiet grey dot. The current stage is a ring with a dot in the app
color, and its name is bold. `current` wins over `done` and `icon`.

## Layout

In a container at least 360 px wide, the stages stand side by side in equal
columns with a line between their dots. A narrower container, such as a phone
sheet, lists them one below the other with the line running down. The switch
follows the container, not the viewport. Dots are 20 px. The first dot starts
on the left edge of the container, so the path stands on the text edge of its
column. Names and detail lines wrap between words instead of being cut. One
below the other, a stage with a detail line is 52 px high, one without 40 px.

The line between the dots is the only line in the flat design that does not
structure the page. It connects the stages. It is 2 px and uses the color of a
field edge, like every other strong line. The state is in the form of the dot
and in words, never in color alone.

## Accessibility

The stages are an ordered list. Each label carries a hidden "done",
"current step", or "not yet" in the request's locale, so the state never
depends on color or the dot alone. The current stage has no `aria-current` in
addition, so screen readers say "current step" once. Icons are decorative.

## Example

```tsx
<ProgressPath
  label="Order 2026-0418"
  steps={[
    { label: "Ordered", detail: "Nov 3", done: true },
    { label: "Shipped", detail: "Nov 5", current: true },
    { label: "Delivered", detail: "expected Nov 8", icon: "ti ti-home" },
  ]}
/>
```

## Runtime

The path renders on the server and needs no JavaScript.
