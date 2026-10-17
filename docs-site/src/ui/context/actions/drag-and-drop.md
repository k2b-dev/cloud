# Drag and drop

`DragSource` moves a typed, opaque payload onto a `DropTarget`. Use it for
rows, tasks, events, or paragraphs inside the page. The application owns the
reference in `value`, the destinations, permissions, and the result of a drop.
The library never interprets the reference or moves application data itself.

## Import

```tsx
import {
  DragSource, DropTarget, useKeyboardDrag, activeDrag,
  type DragPayload, type DragSourceProps, type DropTargetProps,
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
press behavior. Native link and image dragging inside a source is prevented.
The source keeps its box and dims; a fixed preview with the icon, the label,
and the count follows the pointer.

**Touch and pen.** Hold still for `HOLD_MS = 500` ms, then move at least 10 px
from the original point. Moving 10 px before the hold abandons the press and
lets the browser scroll. Once held, the page stays still under the finger.
With [`GestureMenu`](../actions/gestures), the hold opens its menu first;
continued movement closes it and starts the drag, with either nesting order.
A lift after holding or dragging never clicks the row.

**Targets.** The innermost enabled target that accepts the type wins. An
accepting ancestor can take a drop through an incompatible nested target.
If none accepts, the innermost target shows `data-drop="refused"` and its
refusal is announced. Other accepting targets show `data-drop="ok"`; the
current destination shows `data-drop="over"`. Release checks the destination
again at the final pointer position.

**Autoscroll.** Rest within `AUTOSCROLL_EDGE = 32` px of a scroll container's
edge to keep scrolling. The first ancestor that can scroll in that direction
moves by `Math.max(1, Math.ceil(12 * (1 - distanceToEdge / AUTOSCROLL_EDGE)))`
px per animation frame, up to 12 px. Leaving the edge zone stops scrolling.
The document uses the viewport edges, and only while the page is not
scroll-locked. Inside a dialog, scrolling and targets stop at the dialog, so
nothing behind a modal moves or takes a drop.

**Cancel.** Escape, pointer cancellation, window blur, a second pointer, or
unmounting the source cancels without a drop. A button still held after
Escape does not click the row when it is released. Escape is consumed so it does
not also close an enclosing dialog. Cleanup removes preview, target states,
held state, listeners, timers, animation frames, and the text-selection hold.

## Keyboard and menu path

Every drop an application offers also has a menu entry such as **Move to …**
listing its destinations. This is the guaranteed accessible path for keyboard
and screen reader users: a target may not be on screen or mounted at all.
The same handler serves the menu entry and `onDrop`.

`useKeyboardDrag()` is an optional pick-up sequence started from a menu entry
such as **Move…**. Call its returned function with the payload and the row
element. The drag is active at once, so targets a host shows only while
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
cancels the sequence. Focus then returns to the origin, or to its nearest
focusable ancestor such as the `GestureMenu` group, if it is still connected.
Starting another keyboard pickup cancels the previous drag first.

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
`DragSource` and `DropTarget` handle drops elsewhere. A `DragSource` row can
still start `dragIn` itself; the application chooses the interaction it starts.

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
