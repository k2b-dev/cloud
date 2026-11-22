# Progress path

`ProgressPath` shows the stages of one thing in order, each with a word and a
quiet line, such as where an order or a returned item is on its way.

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
`done` when it happened, and an optional Tabler `icon` that an open stage shows
in its circle. A done stage shows a check instead.

## Layout

In a container at least 26rem wide, the stages stand side by side in equal
columns with a line between their circles. A narrower container, such as a
phone sheet, lists them one below the other with the line running down. The
switch follows the container, not the viewport. The line after a done stage is
green; the circle of a done stage has a green edge and a check.

## Accessibility

The stages are an ordered list. Each label carries a hidden "done" or "not yet"
in the request's locale, so the state never depends on color or the check
alone. Icons are decorative.

## Example

```tsx
<ProgressPath
  label="Order 2026-0418"
  steps={[
    { label: "Ordered", detail: "Nov 3", done: true },
    { label: "Shipped", detail: "Nov 5", done: true },
    { label: "Delivered", detail: "expected Nov 8", icon: "ti ti-home" },
  ]}
/>
```

## Runtime

The path renders on the server and needs no JavaScript.
