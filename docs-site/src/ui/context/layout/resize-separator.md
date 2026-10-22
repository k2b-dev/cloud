# ResizeSeparator

Use `ResizeSeparator` between two regions when the application owns their size.
It renders a focusable separator with a label, orientation, current value,
limits, and optional `controls` id. A vertical separator changes column width;
a horizontal separator changes row height. The transparent 12 px hit area
shows a short grip and a soft shadow on the region it resizes during hover,
keyboard focus, and drag. It draws no line. The grip takes the focus color only
on keyboard focus. These cues move no content; their transitions stop under
reduced motion.

## Import

```tsx
import { attachResizeSeparator, ResizeSeparator } from "@k2b/ui";
```

## Use ResizeSeparator

```tsx
const [width, setWidth] = createSignal(240);
<ResizeSeparator
  label="Resize inspector"
  orientation="vertical"
  controls="inspector"
  min={160}
  max={480}
  value={width()}
  grow="start"
  onResize={setWidth}
  onResizeEnd={saveWidth}
  onReset={() => setWidth(240)}
/>
```

`onResize` receives clamped values during a drag and for every handled key.
`onResizeEnd` commits a released drag or keyboard step. `unit` is pixels per
value unit (default 1); for rem sizes, pass the root font size.

`onReset` runs on double-click or Enter while the separator is focused, except
during an active drag. The application
restores its default size and clears any saved preference. With plain server
markup, the callback also updates `aria-valuenow`. Without `onReset`, a
double-click does nothing.

ArrowLeft/ArrowRight resize a vertical separator; ArrowUp/ArrowDown resize a
horizontal separator. `grow="start"` increases the region toward the logical
start; `grow="end"` increases it toward the end. Vertical separators respect RTL
for both resizing and the shadow's position.
`step` defaults to 1, Shift uses `largeStep` (default four steps), Home selects
the minimum, and End selects the maximum. Keys never collapse a region.

Set `collapseBelow` to arm collapse when the raw dragged size falls below that
value. The displayed size stays at least `min`; `onCollapseIntent` receives the
armed state so the application can explain what releasing will do. A release
while armed calls `onCollapse` instead of `onResizeEnd`. `onDragChange` lets the
host shield embedded content during a drag. Pointer cancellation, lost capture,
window blur, and disposal restore the size from before the drag without a
commit or collapse. Text selection is suppressed only during a drag.
Persistence and collapse effects belong to the application.

## Accessibility

- The separator has `role="separator"`, `aria-orientation`, `aria-valuemin`,
  `aria-valuemax`, `aria-valuenow`, and the `label` as its accessible name.
- Connect `controls` to the resized region's id.
- It is a keyboard tab stop. Keyboard focus shows the grip and shadow and gives
  the grip the focus color; hover and drag show the cue without that color.

## Runtime

The component attaches behavior on mount and disposes it on unmount. Render the
same size and ARIA values on the server and in the first client frame. For plain
server markup, call `attachResizeSeparator(element, options)` and dispose its
returned function. The installer reads orientation from `aria-orientation` and
gets the current value through `value: () => number`. Both the component and
`attachResizeSeparator` set `data-resize-edge` from `grow` (`start` or `end`),
so the shadow falls on the resized region. The component renders it on the
server for the first frame.

## Example

```tsx
import { ResizeSeparator } from "@k2b/ui";
import { createSignal, Show } from "solid-js";

const [width, setWidth] = createSignal(240);
const [open, setOpen] = createSignal(true);
const [closing, setClosing] = createSignal(false);

<div class="flex">
  <main class="min-w-0 flex-1">Workspace</main>
  <Show when={open()}>
    <ResizeSeparator
      label="Resize inspector"
      orientation="vertical"
      controls="inspector"
      min={160}
      max={360}
      value={width()}
      grow="start"
      collapseBelow={120}
      onResize={setWidth}
      onReset={() => setWidth(240)}
      onCollapseIntent={setClosing}
      onCollapse={() => setOpen(false)}
    />
    <aside id="inspector" style={{ width: `${width()}px` }}>
      {closing() ? "Release to close" : "Inspector"}
    </aside>
  </Show>
</div>
```
