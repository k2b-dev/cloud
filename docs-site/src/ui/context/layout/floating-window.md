# FloatingWindow

`FloatingWindow` is a movable, resizable, non-modal utility surface. It stays visible while the user continues working in the application.

## Use FloatingWindow

Use it for long-lived reference work such as Help, an assistant, or a preview that belongs beside the main task, and for a draft that should stay open while the person keeps working, such as a new message.

Use a dialog when the user must finish or dismiss the task before continuing. Use an `AppWorkspace.Detail` when the content belongs to the current selection.

## Import

```tsx
import {
  fitFloatingWindowRect,
  FloatingWindow,
  openFloatingWindow,
  type FloatingWindowBounds,
  type FloatingWindowClose,
  type FloatingWindowRect,
  type FloatingWindowState,
} from "@k2b/ui";
```

## Open and close

`openFloatingWindow(view, options)` mounts the window in a portal and returns an idempotent close function.

The `view` also receives that close function. Use it for actions inside the window.

Options include `title`, `icon`, `accent`, initial width and height, minimum width and height, and an optional class.

The helper restores focus to the previously focused element when the window closes. A window focuses itself when it opens, unless its content already placed the focus inside it, such as an editor.

The window is a Solid root of its own with its own error boundary. When the
`view` throws while it opens or on a later update, the window keeps its title
bar and shows "This content could not be displayed." in its body, and the
error goes to `reportError()`. The rest of the page keeps working.

Use `FloatingWindow` directly when reactive JSX already owns whether the
window is mounted. Pass `resolveScope={() => owner}` when the portal must stay
inside a specific `.k2b-ui` application shell. `openFloatingWindow` creates
its own styled owner and supplies that scope unless an explicit resolver is
provided.

## Window behavior

Desktop windows can be moved and resized. Geometry stays inside the `area`, or the viewport without one. Clicking a window brings it in front of other floating windows. Moving or resizing a window never selects page text.

The header shows the title on one line, ending with an ellipsis; pointing at a cut title shows all of it. An optional `status`, such as "Saved", follows the title. Optional `actions` of the content, such as Send, come next. Then come Minimize, Maximize, and Close. A minimized bar hides the status and the actions.

## States

A window is `normal`, `minimized`, or `maximized`.

- **Minimized** windows collapse to a bar with the title, Maximize, and Close, docked at the bottom edge of the area. Several bars line up in one row from the end, in the order the windows opened, and never overlap; a full row continues above. The content stays mounted, so a draft or an editor keeps its state. Clicking the bar restores the window to its previous place and size, and the focus returns to where it was in the content.
- **Maximized** windows cover the area with a small margin and dim the rest of it. Then the window behaves like a modal dialog: Tab stays inside it, and Escape, the Restore size button, or a click on the dimmed area restore it. The focus stays in the window.
- **Normal** windows open centered in the area. With `placement="dock"`, a window opens at the bottom end of the area instead, in one row with the minimized bars, until the person moves it.

None of these states move other content on the page.

Below 640 pixels, an open window is a full-screen sheet: Close stands first, the status sits below the title, the actions stand at the end of the header, and Minimize and Maximize are hidden. Pass the main action of a long form, such as Send, as `actions` on a phone, so it stays within reach above the keyboard. Movement and resizing are off. The sheet is modal for Tab and Escape.

## Keep windows across reloads

The window works without any state from the application. To restore windows, for example after a reload, own the state and the place:

- `state` with `onStateChange`, or `defaultState` for the first state only;
- `rect` with `onRectChange`, which reports the place after the person moved or resized the window. A window without `rect` places itself.

`fitFloatingWindowRect(rect, minWidth, minHeight, bounds)` is the pure
geometry helper used by the component. It returns a clamped
`FloatingWindowRect` inside `bounds`; it does not read the browser or store the result.

## API reference

```ts
type FloatingWindowRect = { x: number; y: number; width: number; height: number };

type FloatingWindowBounds = { x?: number; y?: number; width: number; height: number };

type FloatingWindowState = "normal" | "minimized" | "maximized";

type FloatingWindowProps = {
  title: string; icon?: string; status?: JSX.Element; actions?: JSX.Element; children: JSX.Element; onClose: () => void;
  state?: FloatingWindowState; defaultState?: FloatingWindowState; onStateChange?: (state: FloatingWindowState) => void;
  rect?: FloatingWindowRect; onRectChange?: (rect: FloatingWindowRect) => void; placement?: "center" | "dock";
  area?: () => HTMLElement | null | undefined; initialWidth?: number; initialHeight?: number; minWidth?: number;
  minHeight?: number; accent?: string; class?: string; resolveScope?: () => HTMLElement | null | undefined;
};

type OpenFloatingWindowOptions = Omit<FloatingWindowProps, "children" | "onClose">;

type FloatingWindowClose = () => void;
```

Sizes and coordinates are CSS pixels in the viewport. Defaults: initial 720×640, minimum 360×320, placement `center`, area the viewport. The area can constrain the resulting geometry.

```ts
declare function fitFloatingWindowRect(rect: FloatingWindowRect, minWidth: number, minHeight: number, bounds: FloatingWindowBounds): FloatingWindowRect;
```

`FloatingWindow.open(view: (close: FloatingWindowClose) => JSX.Element, options: OpenFloatingWindowOptions): FloatingWindowClose` mounts a window and returns its close function. `resolveScope` optionally identifies the host theme scope.

## Accessibility

The window uses `role="dialog"` and the title names it. It has `aria-modal="false"`, and `aria-modal="true"` while it is maximized or a phone sheet.

The title control supports arrow-key movement. The lower-right resize control supports arrow-key resizing. Holding Shift uses larger steps. On a minimized bar the title control restores the window.

Minimize, Maximize or Restore size, and Close are icon buttons with names and tooltips. When a window minimizes, the focus moves to its bar.

Escape acts on the window that holds the focus: a maximized window returns to its normal size, any other open window closes. A nested widget that handles Escape itself calls `preventDefault()` first. Escape never closes a minimized bar.

## Runtime

The geometry helper is SSR-safe. Portal mounting and window interaction are
browser-only. `openFloatingWindow` throws when `document` is unavailable.

Open them from an island or another component with browser code. Do not call the helper during SSR.

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

A draft window that docks at the bottom of the application area and comes back after a reload:

```tsx
<FloatingWindow
  title={subject() || "New message"}
  status={saved() ? "Saved" : undefined}
  placement="dock"
  area={() => appArea}
  state={windowState()}
  onStateChange={setWindowState}
  rect={windowRect()}
  onRectChange={setWindowRect}
  initialWidth={540}
  initialHeight={560}
  onClose={closeDraft}
>
  <Composer draft={draft()} />
</FloatingWindow>
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
