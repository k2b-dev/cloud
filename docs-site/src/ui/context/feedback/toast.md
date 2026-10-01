# Toast

`toast` shows transient feedback in a responsive stack. The application supplies the message and decides whether the result is informational, successful, or failed.

A toast is one calm line: a tone glyph, the message, an optional text action, and a close button. Each tone has its own glyph shape (`ti-info-circle`, `ti-circle-check`, `ti-alert-circle`), so tones differ by more than colour. Like dialogs and the Files upload panel, a toast is a floating layer: it has a hairline border and the soft `--k2b-shadow-toast`, the one documented exception to inward-only depth.

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
  type ToastSlot,
} from "@k2b/ui";
```

## Show a toast

```ts
toast("Settings were updated");
toast.success("File uploaded");
toast.error("Upload failed");
```

The first argument is the message. It is the only line most toasts need, so name the outcome in it ("Contact created", "Could not save the draft"). There is no default title: a title appears only when you pass one, as a short line of context the message does not carry ("New version available"). With a title, the message moves under it in the secondary text colour.

Text is never cut off, so it stays readable and can be selected and copied. Aim for about 80 characters, two lines at most.

## Properties

| Property | Type | Default | Purpose |
| --- | --- | --- | --- |
| `variant` | `"default" \| "success" \| "error"` | `"default"` | Selects the semantic treatment. |
| `title` | `string` | none | Adds a line of context above the message. |
| `duration` | `number` | by variant, length, and action | Sets auto-dismiss time in milliseconds. `0` keeps the toast until it is closed. |
| `iconClass` | `string` | variant icon | Overrides the Tabler icon class. |
| `action` | `{ label: string } & ({ href: string } \| { onClick: () => void })`, or `null` | none | Adds one link or callback action; `null` removes it. |
| `progress` | `number \| "indeterminate" \| null` | none | Progress from 0 to 1; `null` restores ordinary dismissal. |
| `dismissLabel` | `string` | "Dismiss notification" / "Benachrichtigung schließen" from the document locale | Names the close button. |

## Timing

Without a `duration`, a toast stays long enough to read and reach:

- success and info: 4 seconds, plus about one second per 30 characters over 40, up to 12 seconds;
- an error or any toast with an action: at least 8 seconds;
- an error longer than 120 characters, and a toast with progress: until it is closed.

An explicit `duration` wins. The timer pauses while the pointer is over the toast, while it contains keyboard focus, and while the browser tab is hidden.

## Stacking

At most three toasts are visible, two on a phone. When another arrives, older success and info toasts leave first, then older errors; running progress and the newest toast stay. A closing toast collapses its space, so its neighbours glide instead of jumping; with reduced motion they move at once.

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

`update` always replaces the description. Only option keys that are present replace existing options; pass `title: undefined` to remove a title. Changing `variant` also changes the icon unless that update supplies `iconClass`. Updating resets the auto-dismiss timer.

Use `toast.dismissAll()` when navigation or a major context change would make existing messages stale.

## Custom content in the rail

When feedback needs more than a description, a bar, and one action, such as a
list of files in an upload, `toast.custom(element)` places an
application-owned element in the same rail. It gets the toast chrome (border,
radius, surface, shadow, 0.75rem padding) and the same enter and leave motion, and it
stacks with ordinary toasts in the same corner instead of covering them.

```ts
const slot = toast.custom(panelElement);
// later, when the work is done or the user closes it
slot.dismiss();
```

The application owns everything inside: layout, a close button, a live region
for announcements, and when to dismiss. A custom slot has no timer, does not
count toward the visible limit, and
`toast.dismissAll()` leaves it in place. When a later toast arrives, the rail
keeps the scroll offsets and the keyboard focus inside the slot, so a
scrolled list or a focused control stays where it was. In Solid, create the element inside a
component or effect so it keeps the locale and other context, and call
`dismiss` from `onCleanup`.

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

Use `action.href` for navigation or `action.onClick` for an application callback, such as undo or cancellation. Supply exactly one behavior. The action is a text button at the end of the message line, before the close button; when the message needs the whole line, the action moves to the end of the next one. Keep its label short. Callback actions do not dismiss automatically and return `void`; the application handles any asynchronous work and its errors.

Do not place a destructive action in a toast. Ask for confirmation before the operation.

## Accessibility

The rail is a region named "Notifications" ("Benachrichtigungen"). Two persistent, empty live regions beside it announce toasts: default and success toasts politely, errors assertively with the localized word "Error:" ("Fehler:") before the message. The announcement holds the title and the message, never the action label. A progress toast is announced when it starts, when it passes half way, and when it ends, not at every update.

A toast closes only through its close button, through Escape while it has focus, through its link action, or when its time runs out. Clicking the text does not close it, so an error message can be selected and copied. When a focused toast closes, focus moves to the next toast or back to where it was before the toast appeared.

On a coarse pointer, such as a phone, the close button and the action accept taps in an invisible area at least 44 px (2.75rem) tall and wide, the same touch target as buttons; neither reaches the other or a neighboring toast.

Messages must identify the affected operation. Do not write "Success" or "Error" as the message; the glyph and the announcement already state the tone.

## Runtime

`toast` is a browser API. Calls made without `document`, including during SSR, return a no-op handle.

The toast rail uses the browser top layer when available so feedback remains visible above dialogs. A toast displayed over a modal is read-only until the modal closes because the browser makes content outside the modal inert.

The rail sits in the bottom-right corner, 22rem wide, newest toast at the
bottom. Below a viewport width of 48rem or a viewport height of 30rem, as on a
phone in portrait or landscape, it moves to the top edge with the newest toast
on top, because there the bottom edge holds dialog footers, bottom sheets, and
primary actions that a toast must not cover. Below 48rem it also spans the
width with a 0.5rem edge.

A host with a fixed header at the top sets `--k2b-toast-offset-top` to the
header's height on an ancestor, such as `:root`, so toasts at the top edge
start below it instead of covering its menu. Cloud's shell does this on phones.

## Example

```ts
toast.success("Message archived", {
  action: { label: "Undo", onClick: () => restore(messageId) },
});
toast("Reload the page to use it.", {
  title: "New version available",
  action: { label: "Reload", onClick: () => location.reload() },
  duration: 0,
});
```

## Progress and cancellation

Pass `progress: 0` through `1` for a determinate bar, or `"indeterminate"` while the total is unknown. A progress toast shows a small ring instead of its glyph and the bar of the Files upload panel under its text: a rounded track in the border colour with an action-coloured fill, green once the variant is `success`. It does not time out. Update the existing handle instead of creating one toast per batch. Pass `progress: null` on completion; ordinary duration behavior resumes.

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

Callback actions do not dismiss automatically; existing `{ label, href }` actions retain their link behavior. Closing the toast only hides feedback, so cancellation must be explicit. The app owns localized descriptions, action labels, and any `title` or `dismissLabel`; the close button's default name, the rail's name, and the announced error word follow the document locale. Throttle frequent progress updates to meaningful milestones. Keep any important partial-result state in the application too, since users can dismiss the toast.
