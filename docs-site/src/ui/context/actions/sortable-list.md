# SortableList

`SortableList` is an ordered list whose rows move by a grip: drag the grip,
or focus it and use the arrow keys. Use it where a person decides an order
that the application saves, such as pinned entries, statuses, or steps.
The host owns the order; the list renders `items` as given and reports moves.

## Import

```tsx
import { SortableList, type SortableListProps } from "@k2b/ui";
```

## Use SortableList

Pass the items, a stable key, and a label per item. Render each row with the
`handle` the list gives you, where the grip belongs. `onMove` receives the
item's key and its new index in the list as it is now; update the order and
save it there.

```tsx
<SortableList
  items={pinned()}
  itemKey={(entry) => entry.id}
  itemLabel={(entry) => entry.title}
  label="Pinned entries"
  onMove={(id, index) => save({ kind: "move", id, index })}
>
  {(entry, handle) => (
    <div class="row">
      {handle}
      <span>{entry().title}</span>
    </div>
  )}
</SortableList>
```

`children` runs once per key. Read the item through `entry()`: it returns
the current copy, so a newer copy from the server updates the row in place,
and the grip keeps keyboard focus across saves.

## Behavior

- **Drag.** The grip is the only place a drag starts; the rest of the row
  keeps its clicks, links, and controls. Dragging uses
  [drag and drop](./drag-and-drop), so mouse slop, hold-then-drag on touch,
  autoscroll in dialogs, Escape, and announcements work the same. The
  dragged row dims in place. The row under the pointer shows a 2 px line on
  the side the row will land on; rows never change size or position while
  dragging.
- **Keyboard.** On a focused grip, ArrowUp and ArrowDown move the row by one,
  Home and End to the start or end. The grip keeps focus, and the shared
  drag live region says the row's new position, such as "Mail, position 2
  of 4." At the edges a key does nothing.
- **Disabled.** `disabled` stops every move and disables the grips.

The grip is named "Move {label}" and describes the keys. Rows that do not
move, such as fixed entries before the list, stay outside it.

## Accessibility

Every move a pointer can make is also possible from the keyboard on the
grip, with spoken feedback. The list takes an optional `label` for screen
readers. The grip is a real button with the shared focus ring.

## API reference

```ts
export type SortableListProps<Item> = {
  items: readonly Item[];
  itemKey: (item: Item) => string;
  itemLabel: (item: Item) => string;
  itemIcon?: (item: Item) => string | undefined;
  onMove: (key: string, index: number) => void;
  label?: string;
  disabled?: boolean;
  class?: string;
  children: (item: () => Item, handle: JSX.Element) => JSX.Element;
};
export function SortableList<Item>(props: SortableListProps<Item>): JSX.Element;
```

`itemIcon` sets the drag preview's Tabler icon; it defaults to the grip.
`class` appends to `k2b-sortable-list`. Rows are `li.k2b-sortable-list__item`;
style the row content you render, not the list's own parts.

## Runtime

Server rendering produces the list, its rows, and the grips without
accessing `window`. Rows are keyed by `itemKey`, so reordering moves row
elements instead of rebuilding them, and a newer copy of an item updates its
row in place. One move calls `onMove` once; the host decides when the new
order is saved and what happens when saving fails.

## Example

The app bar editor in Cloud lists pinned entries this way, saving each move
at once. The live demo keeps the order in a signal.

```tsx
import { SortableList } from "@k2b/ui";
import { createSignal } from "solid-js";

function Steps() {
  const [steps, setSteps] = createSignal([
    { id: "receive", title: "Receive goods" },
    { id: "check", title: "Check delivery" },
    { id: "store", title: "Store in stock" },
  ]);
  const move = (id: string, index: number) => {
    const next = steps().filter((step) => step.id !== id);
    next.splice(index, 0, steps().find((step) => step.id === id)!);
    setSteps(next);
  };
  return (
    <SortableList items={steps()} itemKey={(step) => step.id} itemLabel={(step) => step.title} label="Steps" onMove={move}>
      {(step, handle) => (
        <div class="row">
          {handle}
          <span>{step().title}</span>
        </div>
      )}
    </SortableList>
  );
}
```
