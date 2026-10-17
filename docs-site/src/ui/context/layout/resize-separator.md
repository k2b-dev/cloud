# ResizeSeparator

Use `ResizeSeparator` between two regions when the application owns their size.
It renders a focusable separator with a label, orientation, current value,
limits, and optional `controls` id. A vertical separator changes column width;
a horizontal separator changes row height. The transparent 12 px hit area
contains a 2 px guide that appears on hover, keyboard focus, and drag.

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
/>
```

`onResize` receives clamped values during a drag and for every handled key.
`onResizeEnd` commits a released drag or keyboard step. `unit` is pixels per
value unit (default 1); for rem sizes, pass the root font size. The component
attaches behavior on mount and disposes it on unmount. For plain server markup,
call `attachResizeSeparator(element, options)` and dispose its returned function.
The installer reads orientation from `aria-orientation` and gets the current
value through `value: () => number`.

ArrowLeft/ArrowRight resize a vertical separator; ArrowUp/ArrowDown resize a
horizontal separator. `grow="start"` increases the region toward the logical
start; `grow="end"` increases it toward the end. Vertical separators respect RTL.
`step` defaults to 1, Shift uses `largeStep` (default four steps), Home selects
the minimum, and End selects the maximum. Keys never collapse a region.

Set `collapseBelow` to arm collapse when the raw dragged size falls below that
value. The displayed size stays at least `min`; `onCollapseIntent` receives the
armed state so the application can explain what releasing will do. A release
while armed calls `onCollapse` instead of `onResizeEnd`. `onDragChange` lets the
host shield embedded content during a drag. Pointer cancellation, lost capture,
window blur, and disposal restore the size from before the drag without a
commit or collapse. Text selection is suppressed only during a drag.

Give each separator a meaningful `label` and connect `controls` to the resized
region's id. Render the same size and ARIA values on the server and first client
frame. Persistence and collapse effects belong to the application.
