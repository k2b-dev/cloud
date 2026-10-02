# Description list

`DescriptionList` presents exact key-value information with native description-list semantics.

## Use DescriptionList

Use it for metadata, summaries, and compact detail panels. In `layout="rows"`, a
value may contain one compact control such as a status or assignee picker when
that control has its own accessible name. Use a normal form layout for broader
editing, and do not use the component for arbitrary card layouts.

## Property rows

A property row shows a value that people edit in place: label left, value as
plain text, and the whole row as the control. Put a control with
`appearance="plain"` directly into a row's `description`:
[`Select` and `MultiSelectInput`](/en/ui/input/select#show-a-value-in-a-property-row),
[the date pickers](/en/ui/input/date-picker#show-a-date-in-a-property-row), or
[`NumberInput`](/en/ui/input/number#edit-a-number-in-a-property-row). Give it an
`"aria-label"` that repeats the term.

The row keeps its height and columns. Hovering anywhere in the row, keyboard
focus, or an open picker paints a quiet surface 0.5rem past the row on both
sides, behind the label and value; focus adds the ring to that surface. A click
on the label opens the picker or edits the number. Nothing in the list moves
between these states, and an item `action` stays clickable above the row.
Because the surface reaches past the row, keep 0.5rem of room on both sides,
as a `DetailPanel.Summary` or a section inside a `DetailPanel.Group` does. A
list flush against a scrolling or clipping edge cuts off the surface and its
ring.

Mix property rows with plain text rows freely. For people who cannot edit, render
the same value as text, such as the dot and label of a priority or the
[`Tag`](/en/ui/input/tag-editor) chips of labels, instead of a disabled control.
The row then has no hover surface.

In `layout="rows"`, the term sits where a one-line value sits. A value made
of row-height lines, such as wrapping plain pills or a list of linked items,
keeps the term beside its first line. Plain text that wraps starts at the top
of the row, so the term sits slightly below its first line; keep row values
short and move long text to its own section.

## Import

```tsx
import { Button, DescriptionList } from "@k2b/ui";
```

## Layout

`columns` controls the wide-screen grid and collapses to one column on narrow
screens. Set `layout="rows"` for a compact inspector-style label/value list. An
item may provide one short action directly related to its value. Set
`actionVisibility="progressive"` when repeated row actions should stay quiet:
fine pointers reveal them on row hover or focus, while touch layouts keep them
visible.

Use `layout="compact"` for read-mostly metadata in previews and small panels.
Labels size to their content (up to 40% of the available width), with a smaller
horizontal gap than the space between rows. Unlike inspector rows, compact rows
do not reserve extra height for controls. Values can wrap without losing their
association with the label.

## API reference

```ts
type DescriptionListItem = {
  term: JSX.Element; description: JSX.Element; action?: JSX.Element;
};

type DescriptionListProps = {
  items: readonly DescriptionListItem[]; columns?: 1 | 2 | 3; layout?: "grid" | "rows" | "compact"; size?: "sm" | "md";
  actionVisibility?: "always" | "progressive"; class?: string;
};
```

`columns` defaults to `1`, `layout` to `"grid"`, and `actionVisibility` to `"always"`; `size` defaults to `"md"`. Item content accepts Solid JSX. Only a plain control that is the direct value of a `rows` item takes over the row; nested deeper, such as an add action below a list of entries, it covers only itself.

## Accessibility

The component renders real `dl`, `dt`, and `dd` elements. A property row's
control keeps its own role and name; the row-wide hit area only extends where a
pointer reaches it and adds no second tab stop. Terms must be concise,
descriptions must remain meaningful without visual position, and icon-only
actions need labels. Progressive actions remain keyboard-focusable and become
visible through `focus-within`; visibility must never be the only indication
that an action exists.

## Runtime

Description lists are server-renderable and need no client JavaScript unless an item action is interactive.

## Example

```tsx
<DescriptionList
  layout="rows"
  actionVisibility="progressive"
  items={[
    { term: "Owner", description: "Platform team" },
    { term: "Region", description: "Europe West" },
    { term: "Repository", description: "cloud", action: <Button size="xs">Open</Button> },
  ]}
/>
```
