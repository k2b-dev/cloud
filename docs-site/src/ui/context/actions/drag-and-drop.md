# Drag and drop

`DragSource` moves a typed, opaque payload onto a `DropTarget`. Use it for
rows, tasks, events, or paragraphs inside the page. The application owns the
reference in `value`, the destinations, permissions, and the result of a drop.
The library never interprets the reference or moves application data itself.

## Import

```tsx
import {
  DragSource, DropTarget, DropOverlay, useKeyboardDrag, activeDrag, dragStatus,
  type DragPayload, type DragSourceProps, type DragStatus, type DropTargetProps,
  type DropOverlayProps, type DropOverlayLevel, type DropOverlayTile,
  dropOverlayPages, type DropOverlayPageLabels,
} from "@k2b/ui";
```

## Use DragSource and DropTarget

Wrap the item in `DragSource` and pass `payload`. Its `type` identifies what
it is; targets accept a list of types. Give both the item and the target a
short, meaningful `label` for announcements. `icon` is a Tabler class, defaulting
to `ti ti-file`; `count` above one adds a preview badge.

```tsx
<DragSource payload={{ type: "task", value: "task-42", label: "Review draft" }}>
  <div>Review draft</div>
</DragSource>
<DropTarget accept={["task"]} label="Today" onDrop={scheduleTask}>
  Today
</DropTarget>
```

The payload is read and copied when dragging starts, so a selection can decide
what is dragged. A disabled source starts nothing. A disabled target refuses
every drop, including from the keyboard. `onDrop` runs after drag cleanup;
the host owns asynchronous feedback and recovery from a failed move.

## Behavior

**Pointer.** A primary mouse press with button 0 starts dragging after moving
at least `SLOP = 10` px. Releasing earlier keeps the normal click. Inputs,
textareas, selects, editable content, and `[data-drag-ignore]` keep their own
press and native drag behavior. A source inside editable content, such as a
paragraph in an editor, therefore drags only from a handle marked
`contenteditable="false"`, and its text stays selectable on touch screens.
Elsewhere in a source, native link and image dragging is prevented, and on
touch-only screens its text is not selectable.
The drag captures the mouse, so a release over an iframe such as a PDF
preview still ends it. The source keeps its box and dims; a fixed preview
with the icon, the label, and the count follows the pointer. The preview
floats with the small overlay shadow and hangs below the pointer, so it never
covers the target under it. [SortableList](./sortable-list) shows a copy of
the row instead.

**Touch and pen.** Hold still for `HOLD_MS = 500` ms (a `SortableList` row: 300 ms), then move at least 10 px
from the original point. Moving 10 px before the hold abandons the press and
lets the browser scroll. Once held, the page stays still under the finger,
also for a source without a `GestureMenu`. A platform long press that arrives
earlier, as on Android, counts as the hold.
With [`GestureMenu`](../actions/gestures), the hold opens its menu first;
continued movement closes it and starts the drag, with either nesting order.
A lift after holding or dragging never clicks the row.

**Targets.** The innermost enabled target that accepts the type wins. An
accepting ancestor can take a drop through an incompatible nested target.
If none accepts, the innermost target shows `data-drop="refused"` and its
refusal is announced. Other accepting targets show `data-drop="ok"`; the
current destination shows `data-drop="over"`. Release checks the destination
again at the final pointer position. Only `over` changes the look: a blue
tint with blue text. `ok` and `refused` keep the calm look; the
announcement and the status line say where the item can go.

**Autoscroll.** Rest within `AUTOSCROLL_EDGE = 32` px of a scroll container's
edge to keep scrolling. The first ancestor that can scroll in that direction
moves by `Math.max(1, Math.ceil(12 * (1 - distanceToEdge / AUTOSCROLL_EDGE)))`
px per animation frame, up to 12 px. Leaving the edge zone stops scrolling.
The document uses the viewport edges, and only while the page is not
scroll-locked. Inside a dialog, scrolling and targets stop at the dialog, so
nothing behind a modal moves or takes a drop.

**Cancel.** Escape, pointer cancellation, window blur, a second pointer, or
unmounting the source cancels without a drop. A button still held after
Escape does not click the row when it is released. During a drag, Escape is
consumed so it does not also close an enclosing dialog. Escape also ends a
held touch that has not moved yet; there it still reaches the menu the hold
opened. Cleanup removes preview, target states, held state, listeners,
timers, animation frames, and the text-selection hold.

## Keyboard and menu path

Every drop an application offers also has a menu entry such as **Move to …**
listing its destinations. This is the guaranteed accessible path for keyboard
and screen reader users: a target may not be on screen or mounted at all.
The same handler serves the menu entry and `onDrop`.

`useKeyboardDrag()` is an optional pick-up sequence started from a menu entry
such as **Move…**. Call its returned function with the payload and the row
element. The sequence loads on first use and starts a moment later; if it
cannot load, the live region says so. The drag is active at once, so targets a host shows only while
dragging take part too. It then visits the enabled, accepting targets a
pointer could reach (shown, not inert, not behind a modal dialog) in document
order. With no destination, it announces that no place takes the item.

| Key | Result |
| --- | --- |
| ArrowDown, ArrowRight, Tab | Next destination, wrapping |
| ArrowUp, ArrowLeft, Shift+Tab | Previous destination, wrapping |
| Home, End | First or last destination |
| Enter, Space | Drop on the chosen destination |
| Escape | Cancel |

Pickup announces the instructions together with the first destination. Each
further choice scrolls into view and announces its position. A pointer press
cancels the sequence. When a dialog level opens over the origin, the next key
or press cancels it, and that key still reaches the dialog. Focus then
returns to the origin, or to its nearest focusable ancestor such as the
`GestureMenu` group, if it is still connected. When a held finger turns a
`GestureMenu` into a drag, focus returns from the closed menu to its group.
Starting another keyboard pickup cancels the previous drag first.

## Drop overlay

`DropOverlay` covers the host's main area with large drop targets while an
item it takes is dragged, such as "Assign to me" or "Move to folder" for a
mail. Place it in a positioned box beside the list it serves, not inside a
`k2b-divided` list; it lies above the list, takes no space, and moves
nothing. Only its tiles scroll; the area where letting go changes nothing
stays in view. Each tile says its name to screen readers and in the status
line; a disabled tile says its reason. Targets elsewhere, such as folders in
a sidebar, stay `DropTarget`s of the same drag.

```tsx
<main style={{ position: "relative" }}>
  <For each={mails()}>
    {(mail) => (
      <DragSource threshold={6} touch="none" payload={{ type: "mail", value: mail.id, label: mail.subject }}>
        <MailRow mail={mail} />
      </DragSource>
    )}
  </For>
  <DropOverlay
    accept={["mail"]}
    hint="Folders on the left work too"
    level={(id) =>
      id === "folders"
        ? { title: "Move to folder", tiles: folders().map((folder) => ({ id: folder.id, label: folder.name, icon: "ti ti-folder", onDrop: (item) => move(item.value, folder.id) })) }
        : { tiles: [
            { id: "me", label: "Assign to me", icon: "ti ti-user-plus", onDrop: (item) => assignToMe(item.value) },
            { id: "folder", label: "Move to folder", icon: "ti ti-folder-symlink", opens: "folders" },
          ] }
    }
  />
</main>
```

- **Levels.** `level(id, payload)` returns the tiles of a level, starting with
  `"root"`, from data the page already has: the overlay asks for nothing over
  the network. Tiles on the first level are at least 112 px high, others
  72 px.
- **Resting.** A tile with `opens` shows a chevron and fills a ring while the
  pointer rests on it; after 450 ms its level opens, and "Back" returns.
  Sweeping over it opens nothing, and after a level change resting opens
  nothing until the pointer has moved, so levels never open by themselves. A tile with `opens` and `onDrop` takes a drop as well, such as
  "Assign to someone else" opening a person search.
- **Arming.** New tiles take nothing for 220 ms, so a tile that appears under
  the pointer is never hit by accident; then the target under the resting
  pointer is found again.
- **Nothing happens.** The area "Drop here: nothing happens", the overlay
  around the tiles, and a tile with `disabled` (its reason shows in place of
  the description) change nothing, like Escape, leaving the window, or a
  cancelled pointer.
- **Touch.** Give the rows `touch="none"`: a finger never drags them.
  With `onLongPress`, a finger held 500 ms, moving at most 8 px, calls it at
  the press point, so the host opens the row's menu with the same targets;
  the release after it never clicks the row. `threshold={6}` starts a mouse
  drag after 6 px.
- **Long lists.** `dropOverlayPages(id, tiles, labels)` splits many tiles
  over levels: the first 11 and "More N", behind it the rest or, when it does
  not fit one level, ranges of at most 12 in the given order. Ask it first in
  `level`:
  ```tsx
  const people = dropOverlayPages("people", persons().map(toTile), {
    title: "Assign to someone else · Frequent",
    moreTitle: "Assign to someone else · More",
    more: (count) => `More ${count} people`,
    range: (first, last) => `${first} – ${last}`,
  });
  const level = (id: string) => people(id) ?? rootLevel;
  ```
- **Cancelled.** `onCancel(payload)` runs when a drag of an item the overlay
  takes ends without a drop, so the host can say "Cancelled, nothing
  changed". After a drop, the tile's `onDrop` shows the host's toast with
  "Undo".
- **Loading.** The overlay's code loads on demand: while the page is idle
  after the overlay mounts, and on every press of a drag source. The first
  drag shows it at once; when loading fails, the live region says so and the
  menu remains.

The overlay is for the pointer; every target also needs a menu entry. A
keyboard pickup (`useKeyboardDrag`) offers the tiles of the current level
that take a drop, never the areas that change nothing. A pen drags like the
mouse on a source with `touch="none"`. Over the overlay the preview shows
only its icon and count, as the top line names the item.

## Status line

`dragStatus()` is reactive and defined while a drag or a keyboard pickup
runs. Its `lead` names what moves ("“Review draft” is being moved", or "3
items are being moved"); its `detail` says where it goes and how to cancel
("to “Today” · Esc cancels"). A host's status line shows it in place of its
key figures, in a box of fixed height, so nothing moves. The same words reach
screen readers through the live region.

## Hosts and far-away targets

Any `DropTarget` anywhere in the same document registers, for example in a
shell rail. Hosts can read the reactive `activeDrag()` payload to show a
**Drop into** column only while dragging. A newly mounted target immediately
shows its accepting state. Unmounting a target unregisters it and clears its
state. Keep the source mounted until the drag ends.

```tsx
<Show when={activeDrag()}>
  <DropTarget accept={["task"]} label="Later" onDrop={moveLater}>Later</DropTarget>
</Show>
```

Keep a menu entry for destinations outside the current view, even when the
host also offers a temporary drop column. Mount temporary targets in reserved
space or an overlay so their appearance does not shift the list.

## Relation to FileDropTarget and Calendar

[`FileDropTarget`](../input/file-drop-target) takes files from outside the
page through native drag events; that behavior is unchanged.
`CalendarController.dragIn` remains the [calendar's](../surfaces/calendar)
own drop into free time, with `CalendarExternalDrag` unchanged.
`DragSource` and `DropTarget` handle drops elsewhere. Use either
`DragSource` or `dragIn` on one press region, as both start on the same
press. An item that offers both uses a separate handle for one of them, or
disables its `DragSource` where `dragIn` starts.

## Accessibility

One shared polite live region announces pickup, choices, refusal, drop, and
cancellation in the inherited locale (English or German). Inside an open
modal dialog, the announcer lives in that dialog. The region exists from the
first mounted source or target on, so the first announcement is read. Repeated
identical announcements are refreshed for assistive technology.

The refused state does not rely on colour alone: its announcement names the
target and says it does not take the item. Keyboard pickup restores focus.
Always supply the direct **Move to** menu entries as well as any drag shortcut.
Wrappers do not add a tab stop or pretend the item is a button.

## API reference

```ts
export type DragPayload<Type extends string = string> = {
  type: Type;
  value: string;
  label: string;
  icon?: string;
  count?: number;
};
export type DragSourceProps<Type extends string = string> = {
  payload: DragPayload<Type>;
  disabled?: boolean;
  threshold?: number;
  touch?: "drag" | "none";
  onLongPress?: (point: { x: number; y: number }) => void;
  class?: string;
  children: JSX.Element;
};
export type DropTargetProps<Type extends string = string> = {
  accept: readonly Type[];
  label: string;
  onDrop: (payload: DragPayload<Type>) => void;
  disabled?: boolean;
  class?: string;
  children: JSX.Element;
};
export function DragSource<Type extends string = string>(props: DragSourceProps<Type>): JSX.Element;
export function DropTarget<Type extends string = string>(props: DropTargetProps<Type>): JSX.Element;
export function useKeyboardDrag(): (payload: DragPayload, origin: HTMLElement) => void;
export function activeDrag(): DragPayload | undefined;
export type DropOverlayTile = {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  leading?: JSX.Element;
  disabled?: string;
  opens?: string;
  onDrop?: (payload: DragPayload) => void;
};
export type DropOverlayLevel = { title?: string; tiles: readonly DropOverlayTile[] };
export type DropOverlayProps = {
  accept: readonly string[];
  level: (id: string, payload: DragPayload) => DropOverlayLevel;
  hint?: string;
  onCancel?: (payload: DragPayload) => void;
  class?: string;
};
export function DropOverlay(props: DropOverlayProps): JSX.Element;
export type DropOverlayPageLabels = {
  title?: string;
  moreTitle?: string;
  more: (count: number) => string;
  range: (first: string, last: string, count: number) => string;
};
export function dropOverlayPages(
  id: string,
  tiles: readonly DropOverlayTile[],
  labels: DropOverlayPageLabels,
  limits?: { first?: number; size?: number },
): (level: string) => DropOverlayLevel | undefined;
export type DragStatus = { lead: string; detail: string };
export function dragStatus(): DragStatus | undefined;
```

`type` selects accepting targets; `value` stays opaque. `label` names the item
in the preview and speech. Source and target `class` append to
`k2b-drag-source` and `k2b-drop-target` respectively. State attributes change
appearance without changing layout.

## Runtime

Gestures run only in the browser. The preview opens as a manual popover in
the top layer, so a transformed or modal dialog neither offsets nor covers it. Server rendering produces the two `div`
wrappers and children without accessing `window`. There is one engine per
document. Moves update once per animation frame. Hit testing walks ancestors
from one `elementFromPoint` result, and autoscroll caches computed overflow
for the session; cost per frame is independent of the number of registered
targets. Start and cleanup mark the registry once.

## Example

This mail-like row lists both destinations in its menu and adds optional
keyboard pickup. The live demo uses four rows and adds an incompatible
Calendar destination to show refusal.

```tsx
import { DragSource, DropTarget, GestureMenu, useKeyboardDrag } from "@k2b/ui";
import { createSignal } from "solid-js";

function MailRow() {
  const pickUp = useKeyboardDrag();
  const [last, setLast] = createSignal("Nothing yet");
  let row!: HTMLDivElement;
  const payload = { type: "mail.message", value: "message-42", label: "Message from Nora", icon: "ti ti-mail" };
  const move = (target: string) => setLast(`${payload.label} → ${target}`);
  return <>
    <DragSource payload={payload}>
      <GestureMenu label={payload.label} items={[
        { sectionLabel: "Move to", items: [
          { label: "Archive", action: () => move("Archive") },
          { label: "Later", action: () => move("Later") },
        ] },
        { label: "Move…", icon: "ti ti-arrows-move", action: () => pickUp(payload, row) },
      ]}>
        <div ref={row}>Nora · The draft is ready for review.</div>
      </GestureMenu>
    </DragSource>
    <DropTarget accept={["mail.message"]} label="Archive" onDrop={() => move("Archive")}>Archive</DropTarget>
    <DropTarget accept={["mail.message"]} label="Later" onDrop={() => move("Later")}>Later</DropTarget>
    <p aria-live="polite">Last: {last()}</p>
  </>;
}
```
