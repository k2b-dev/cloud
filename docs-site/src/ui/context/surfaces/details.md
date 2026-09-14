# Description list

`DescriptionList` presents exact key-value information with native description-list semantics.

## Use DescriptionList

Use it for metadata, summaries, and compact detail panels. In `layout="rows"`, a
value may contain one compact control such as a status or assignee picker when
that control has its own accessible name. Use a normal form layout for broader
editing, and do not use the component for arbitrary card layouts.

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

`columns` defaults to `1`, `layout` to `"grid"`, and `actionVisibility` to `"always"`; `size` defaults to `"md"`. Item content accepts Solid JSX.

## Accessibility

The component renders real `dl`, `dt`, and `dd` elements. Terms must be concise,
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
