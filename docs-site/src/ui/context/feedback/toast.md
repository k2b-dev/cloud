# Toast

`toast` shows transient feedback in a responsive stack. The application supplies the message and decides whether the result is informational, successful, or failed.

## Use toast

Use a toast after a non-blocking action when the user can continue without responding.

Use `prompts` when work must pause for acknowledgement or a decision. Keep failures visible in the page when they prevent the user from completing the current task.

## Import

```ts
import {
  isPointInsideToast,
  toast,
  type ToastHandle,
  type ToastOptions,
} from "@k2b/ui";
```

## Show a toast

```ts
toast("Settings were updated");
toast.success("File uploaded");
toast.error("Upload failed");
```

The first argument is the description. The default titles are `Info`, `Success`, and `Error`.

## Properties

| Property | Type | Default | Purpose |
| --- | --- | --- | --- |
| `variant` | `"default" \| "success" \| "error"` | `"default"` | Selects the semantic treatment. |
| `title` | `string` | variant title | Overrides the title. |
| `duration` | `number` | `3000` | Sets auto-dismiss time in milliseconds. `0` creates a sticky toast. |
| `iconClass` | `string` | variant icon | Overrides the Tabler icon class. |
| `action` | `{ label: string; href: string } \| null` | none | Adds or removes a navigation link. |

At most five toasts remain visible. Adding another dismisses the oldest.

## Update or dismiss

Every call returns a handle:

```ts
const upload = toast("0%", {
  title: "Uploading",
  duration: 0,
});

upload.update("50%");
upload.update("Upload complete", {
  variant: "success",
  title: "Done",
  duration: 2_000,
});

upload.dismiss();
```

`update` always replaces the description. Only option keys that are present replace existing options. Changing `variant` also changes the default title and icon unless that update supplies overrides. Updating resets the auto-dismiss timer.

Use `toast.dismissAll()` when navigation or a major context change would make existing messages stale.

## Hit-testing the toast rail

Toasts render in the top layer above every application surface, so an
outside-click handler will see clicks that landed on a toast as clicks outside
its own surface. `isPointInsideToast(x, y)` answers whether viewport
coordinates fall inside a live toast, so those clicks can be ignored:

```ts
element.addEventListener("pointerdown", (event) => {
  if (isPointInsideToast(event.clientX, event.clientY)) return;
  closeOverlay();
});
```

The package's own dialogs already use it; it is exported for applications that
build their own light-dismiss surfaces. It returns `false` on the server.

## Actions

Toast actions are links. Use them to open a destination related to the completed operation.

Pass `action.href`; toast actions do not accept an `onClick` callback.

Do not place a destructive action in a toast. Ask for confirmation before the operation.

## Accessibility

Default and success toast content uses a polite, atomic status live region. Error toasts use an assertive alert. A visible close button is always present. Auto-dismiss pauses while the toast is hovered or contains keyboard focus.

Messages must identify the affected operation. Avoid “Success” as the description because the title already states the variant.

## Runtime

`toast` is a browser API. Calls made without `document`, including during SSR, return a no-op handle.

The toast rail uses the browser top layer when available so feedback remains visible above dialogs. A toast displayed over a modal is read-only until the modal closes because the browser makes content outside the modal inert.

## Example

```ts
toast.success("Item moved", {
  title: "Moved to Archive",
  action: {
    label: "Open Archive",
    href: "/app/files/archive",
  },
  duration: 8_000,
});
```

## Progress and cancellation

Pass `progress: 0` through `1` for a determinate bar, or `"indeterminate"` while the total is unknown. A progress toast does not time out or dismiss when its body is clicked. Update the existing handle instead of creating one toast per batch. Pass `progress: null` on completion; ordinary duration behavior resumes.

```ts
const controller = new AbortController();
const notice = toast("Preparing import", {
  title: "Import",
  progress: "indeterminate",
  action: { label: "Cancel", onClick: () => controller.abort() },
  dismissLabel: "Dismiss notification",
});
notice.update("500 / 1000 records saved", { progress: 0.5 });
notice.update("1000 records saved", {
  title: "Import completed", variant: "success", progress: null, action: null,
});
```

Callback actions do not dismiss automatically; existing `{ label, href }` actions retain their link behavior. Closing the toast only hides feedback, so cancellation must be explicit. The app owns localized titles, descriptions, action labels and `dismissLabel`. Throttle frequent progress updates to meaningful milestones. Keep any important partial-result state in the application too, since users can dismiss the toast.
