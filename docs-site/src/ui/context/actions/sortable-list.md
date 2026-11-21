# SortableList

`SortableList` is an ordered list whose rows move by pointer, touch, or
keyboard. Use it where a person decides an order that the application saves,
such as pinned entries, statuses, or steps. Lists that share a `group`
exchange rows, so the columns of a board are sortable lists too. The host
owns the order; the list renders `items` as given and reports moves.

## Import

```tsx
import { SortableList, useSortableMoveMenu, type SortableListProps, type SortableMove } from "@k2b/ui";
```

## Use SortableList

Pass the items, a stable key, and a label per item. Render each row with the
`handle` the list gives you, where the grip belongs. `onMove` receives the
item's key, its index in the list after the move, and a `SortableMove`;
update the order and save it there.

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

## Columns of a board

Give every column the same `group`, its own `listKey`, and a `listLabel`
such as "Done". `onMove` of the column the row lands in runs once; for a row
from another column, `move.from` names that column, and the host takes the
row out of it in the same update. `dragBy="row"` drags the whole card, so a
card is picked up wherever it is pressed; a click without movement still
opens it. The keyboard always uses the grip.

```tsx
const move = (id: string, index: number, move: SortableMove) => {
  setBoard((all) => {
    const next = { ...all, [move.from]: all[move.from].filter((other) => other !== id) };
    const to = next[move.to].filter((other) => other !== id);
    to.splice(index, 0, id);
    return { ...next, [move.to]: to };
  });
  toast("Moved", { action: { label: "Undo", variant: "ghost", onClick: move.undo } });
};

<section data-sortable-column>
  <header data-sortable-column-head>In progress</header>
  <SortableList group="board" listKey="doing" listLabel="In progress" dragBy="row"
    items={board().doing} itemKey={(id) => id} itemLabel={title} onMove={move}>
    {(id, handle) => <Card id={id()} grip={handle} />}
  </SortableList>
</section>
```

- **Column head.** Mark the column with `data-sortable-column` and its head
  with `data-sortable-column-head`. While a row would land in that column,
  the column carries `data-sortable-target` and its head is tinted blue.
  The whole column, also its head and the empty space below the cards, takes
  the drop.
- **Sorted column.** `placement(key, from)` returns where the row lands
  among the column's items without it. The line then shows that place,
  wherever the pointer is in the column, and the drop uses it.
- **Undo.** `move.undo()` moves the row back through the lists' own
  `onMove`. The list shows no toast; the host shows one with "Undo".
- **Phone.** Below 768 px, rows of a `group` do not drag. Offer
  `useSortableMoveMenu(group)` in the card's menu: it returns a "Move to"
  section with one entry per other column, or `undefined`.
  ```tsx
  const moveMenu = useSortableMoveMenu("board");
  <Dropdown.Root items={[moveMenu(id)].filter((section) => section !== undefined)} />
  ```
- **Gap.** Set `--k2b-sortable-gap` on the list or an ancestor, with a unit,
  such as `0px` for cards between hairlines; the line sits in the middle of
  it. `--k2b-sortable-line-inset` sets where the line starts and ends.

## Behavior

- **Nothing jumps.** The moved row stays dimmed in its place until it is
  dropped. A 2 px blue line with a dot at its start shows where it lands; the
  line lies over the gap and takes no space, so no row moves, in any list,
  before the drop. There is no animation that shifts neighbours.
- **Pointer.** In `dragBy="handle"` (the default), the grip is the only place
  a drag starts; the rest of the row keeps its clicks, links, and controls.
  Dragging uses [drag and drop](./drag-and-drop), so mouse slop,
  hold-then-drag on touch (300 ms; a finger that moves earlier scrolls),
  autoscroll at the edges of the column and the page, and announcements work
  the same. The line sits above the row under the pointer, and at most 8 px
  below the pointer; the preview, a copy of the row with a small shadow,
  hangs 16 px below the pointer, so it never covers the line.
- **Cancel.** Escape, or letting go outside every list of the group, puts the
  row back. There is no separate cancel area.
- **Keyboard.** On a focused grip, Space or Enter lifts the row. While it is
  lifted, ArrowUp and ArrowDown choose the place, Home and End the first or
  last place, ArrowLeft and ArrowRight the column before or after; Enter or
  Space drops, and Escape, Tab, or a pointer press cancel. Nothing moves
  until the drop; the line and the tinted head show the place, and focus
  stays on the grip, also after the drop into another column. Without
  lifting, ArrowUp and ArrowDown move the row by one at once, Home and End to
  the start or end. At the edges a key does nothing.
- **Disabled.** `disabled` stops every move and disables the grips; the list
  then refuses rows from other lists.

## Status line and announcements

The shared polite live region says "Impressum lifted. Position 1 of 8 in
“Open”.", then each place, such as "Position 3 of 7 in “Done”.", then the
drop or "Cancelled. Impressum stays where it was." in the inherited locale
(English or German). The same words reach a visible status line through the
reactive `dragStatus()` of [drag and drop](./drag-and-drop): `lead` names
what moves, `detail` says where it goes and how to cancel, such as
"to “In progress”, place 2 · Esc cancels". A host shows it in place of its
key figures while it is defined; it needs no import of the status line.

The grip is named "Move {label}" and describes the keys. Rows that do not
move, such as fixed entries before the list, stay outside it.

## Accessibility

Every move a pointer can make is also possible from the keyboard on the
grip, with spoken feedback, and through the move menu. The list takes an
optional `label` for screen readers. The grip is a real button with the
shared focus ring; its description lists the keys.

## API reference

```ts
export type SortableListProps<Item> = {
  items: readonly Item[];
  itemKey: (item: Item) => string;
  itemLabel: (item: Item) => string;
  itemIcon?: (item: Item) => string | undefined;
  onMove: (key: string, index: number, move: SortableMove) => void;
  label?: string;
  disabled?: boolean;
  class?: string;
  group?: string;
  listKey?: string;
  listLabel?: string;
  placement?: (key: string, from: string) => number;
  dragBy?: "handle" | "row";
  children: (item: () => Item, handle: JSX.Element) => JSX.Element;
};
export type SortableMove = { from: string; to: string; fromIndex: number; undo: () => void };
export function SortableList<Item>(props: SortableListProps<Item>): JSX.Element;
export function useSortableMoveMenu(group: string): (key: string) => DropdownSection | undefined;
```

The preview shows a copy of the row at its width, inside a shallow copy of
the list element, so the row's own classes style it; `itemIcon` is used only
when no row can be shown. `class` appends to `k2b-sortable-list`. Rows are
`li.k2b-sortable-list__item`; style the row content you render, not the
list's own parts. A lifted row carries `data-sortable-dragging`, the row with
the line `data-sortable-line="before"` or `"after"`, and an empty target list
`data-sortable-line="empty"`.

## Runtime

Server rendering produces the list, its rows, and the grips without
accessing `window`. Rows are keyed by `itemKey`, so reordering moves row
elements instead of rebuilding them, and a newer copy of an item updates its
row in place. One move calls `onMove` once; the host decides when the new
order is saved and what happens when saving fails. A pointer move measures
the rows of the list under the pointer once per animation frame.

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
