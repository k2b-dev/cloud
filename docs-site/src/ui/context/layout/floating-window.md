# FloatingWindow

`FloatingWindow` is a movable, resizable, non-modal utility surface. It stays visible while the user continues working in the application.

## Use FloatingWindow

Use it for long-lived reference work such as Help, an assistant, or a preview that belongs beside the main task.

Use a dialog when the user must finish or dismiss the task before continuing. Use an `AppWorkspace.Detail` when the content belongs to the current selection.

## Import

```tsx
import {
  fitFloatingWindowRect,
  FloatingWindow,
  openFloatingWindow,
  type FloatingWindowClose,
  type FloatingWindowRect,
} from "@k2b/ui";
```

## Open and close

`openFloatingWindow(view, options)` mounts the window in a portal and returns an idempotent close function.

The `view` also receives that close function. Use it for actions inside the window.

Options include `title`, `icon`, `accent`, initial width and height, minimum width and height, and an optional class.

The helper restores focus to the previously focused element when the window closes.

Use `FloatingWindow` directly when reactive JSX already owns whether the
window is mounted. Pass `resolveScope={() => owner}` when the portal must stay
inside a specific `.k2b-ui` application shell. `openFloatingWindow` creates
its own styled owner and supplies that scope unless an explicit resolver is
provided.

## Window behavior

Desktop windows can be moved and resized. Geometry is clamped to the viewport. Clicking a window brings it in front of other floating windows.

Below 640 pixels, the window becomes an inset surface with a `0.5rem` viewport
gap and disables movement and resizing.

The component does not persist its position. Add product-owned persistence only when restoring utility geometry is a real requirement.

`fitFloatingWindowRect(rect, minWidth, minHeight, viewport)` is the pure
geometry helper used by the component. It returns a clamped
`FloatingWindowRect`; it does not read the browser or store the result.

## API reference

```ts
type FloatingWindowRect = { x: number; y: number; width: number; height: number };

type FloatingWindowProps = {
  title: string; icon?: string; children: JSX.Element; onClose: () => void; initialWidth?: number;
  initialHeight?: number; minWidth?: number; minHeight?: number; accent?: string; class?: string;
  resolveScope?: () => HTMLElement | null | undefined;
};

type OpenFloatingWindowOptions = Omit<FloatingWindowProps, "children" | "onClose">;

type FloatingWindowClose = () => void;
```

Sizes and coordinates are CSS pixels. Defaults: initial 720×640, minimum 360×320. The viewport can constrain the resulting geometry.

```ts
declare function fitFloatingWindowRect(rect: FloatingWindowRect, minWidth: number, minHeight: number, viewport: { width: number; height: number }): FloatingWindowRect;
```

`FloatingWindow.open(view: (close: FloatingWindowClose) => JSX.Element, options: OpenFloatingWindowOptions): FloatingWindowClose` mounts a window and returns its close function. `resolveScope` optionally identifies the host theme scope.

## Accessibility

The window uses `role="dialog"` with `aria-modal="false"`. The title names it.

The title control supports arrow-key movement. The lower-right resize control supports arrow-key resizing. Holding Shift uses larger steps.

Escape closes only the top floating window.

## Runtime

The geometry helper is SSR-safe. Portal mounting and window interaction are
browser-only. `openFloatingWindow` throws when `document` is unavailable.

Open them from an island or another hydrated client component. Do not call the helper during SSR.

## Example

```tsx
const close = openFloatingWindow(
  (closeWindow: FloatingWindowClose) => (
    <HelpReader articleId={articleId} onClose={closeWindow} />
  ),
  {
    title: "Help",
    icon: "ti ti-help",
    accent: app.appearance.accent,
    initialWidth: 520,
    initialHeight: 640,
  },
);
```

For reactive ownership:

```tsx
let appShell: HTMLDivElement | undefined;

<div ref={appShell}>
  <Show when={open()}>
    <FloatingWindow
      title="Preview"
      resolveScope={() => appShell}
      onClose={() => setOpen(false)}
    >
      <Preview />
    </FloatingWindow>
  </Show>
</div>;
```
