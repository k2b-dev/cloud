# Toast

`toast` shows transient feedback in a responsive stack. The application supplies the message and decides whether the result is informational, successful, or failed.

A toast is one calm line: a tone glyph, the message, an optional text action, and a close button. Each tone has its own glyph shape (`ti-info-circle`, `ti-circle-check`, `ti-alert-circle`), so tones differ by more than colour. Like dialogs and the Files upload panel, a toast is a floating layer: it has a hairline border and the soft `--k2b-shadow-toast`, the one documented exception to inward-only depth.

## Use toast

Use a toast after a non-blocking action when the user can continue without responding. Choose the feedback for an outcome by what the user needs next:

| Outcome | Feedback |
| --- | --- |
| Success that shows where the user acted: a ticked item, a new comment, a moved card, a saved field | None. The changed screen is the confirmation. |
| Success whose effect is not on screen: sent, moved elsewhere, created outside the current view, finished in the background | `toast.success`, with an Undo action when the operation can be undone. |
| A single action failed and the user can try again: a toggle, a move, a save, a refresh after a saved change | `toast.error` that names what failed, with a Retry action when repeating the same request is safe. |
| Input that blocks a form or composer | An inline error next to the field, such as the field's `error` state or `InlineGuidance`. The input stays. |
| A destructive action, or a failure that cannot be recovered and needs a decision | A dialog: `prompts.confirm` before the action, `prompts.error` when the user must read the failure before continuing. |

Toasts confirm only what the user cannot see. A toast for every visible change teaches people to ignore the rail, including its errors. An error dialog for a one-click action interrupts more than the failure deserves: the toast names it and offers the retry.

Retry repeats the failed request with the intent captured when it started: the target, such as the item or Space ID, the values, and any follow-up such as a return address. It then still applies to the same object after the user has moved on. Offer it when repeating cannot do harm, such as setting a value, deleting, refreshing, or a request with an idempotency key, and when the input would otherwise be lost because its form or picker has already closed. A create without an idempotency key can then create the object twice if the first request reached the server, the same risk as entering it again. When a change was saved but the view could not refresh, say that the change was saved and let Retry refresh the view, not repeat the change. Dismiss the error toast when its Retry starts, so a second failure shows a fresh one:

```ts
const notice = toast.error("Could not complete the task", {
  action: {
    label: "Retry",
    onClick: () => {
      notice.dismiss();
      void completeTask({ taskId, completed: true });
    },
  },
});
```

A toast over a modal dialog is not announced and cannot be reached until the dialog closes. Show feedback for work inside a dialog in the dialog itself, and keep a failure that prevents the current task visible in the page.

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

An explicit `duration` wins. Every toast's timer pauses while the pointer is over any toast or custom slot in the rail, while one of them holds keyboard focus, and while the browser tab is hidden, so a toast never slides away from under the pointer or focus because a neighbour expired. The pause ends when the pointer moves elsewhere or focus leaves the rail, also when the hovered or focused control, or the whole rail, is removed from the page.

## Stacking

At most three toasts are visible, two on a phone. When another arrives, older timed success and info toasts leave first, then older errors and toasts that stay until closed (`duration: 0`, or a long error). Running progress, the newest toast, and a toast under the pointer or with keyboard focus stay; while only such toasts remain, the rail shows more than the limit until the pointer or focus leaves. The limit applies again when an update ends a toast's progress or changes its duration. A closing toast collapses its space, so its neighbours glide instead of jumping; with reduced motion they move at once.

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

The rail is a region named "Notifications" ("Benachrichtigungen"). Two persistent, empty live regions beside it announce toasts: default and success toasts politely, errors assertively with the localized word "Error:" ("Fehler:") before the message. The announcement holds the title and the message, never the action label. A progress toast is announced when it starts, when it passes half way, and when it ends, each time only if its message changed; it is not announced at every update. A change to the error variant is announced even when the text stays the same. The regions are not atomic, so each announcement is read once on its own.

A toast closes only through its close button, through Escape while it has focus, through its link action, or when its time runs out. Clicking the text does not close it, so an error message can be selected and copied. When a focused toast closes, focus moves to the next toast or back to where it was before the toast appeared. When an update replaces or removes the focused action, focus stays in the toast, on the new action or on the close button.

On a coarse pointer, such as a phone, the close button and the action accept taps in an invisible area at least 44 px (2.75rem) tall and wide, the same touch target as buttons; neither reaches the other or a neighboring toast.

Messages must identify the affected operation. Do not write "Success" or "Error" as the message; the glyph and the announcement already state the tone.

## Runtime

`toast` is a browser API. Calls made without `document`, including during SSR, return a no-op handle.

The toast rail uses the browser top layer when available so feedback remains visible above dialogs. A toast displayed over a modal is read-only until the modal closes because the browser makes content outside the modal inert. For the same reason, screen readers do not announce toasts that appear while a modal dialog is open; show a failure that belongs to a dialog in the dialog itself.

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

Pass `progress: 0` through `1` for a determinate bar, or `"indeterminate"` while the total is unknown. A progress toast shows a small ring instead of its glyph and the bar of the Files upload panel: a rounded track in the border colour with an action-coloured fill, green once the variant is `success`. With a title it follows the panel's order: the title, the bar, then the message as a summary line ("6 of 12 files") with the action at its end; without a title, the message and action keep the first line and the bar follows. The bar reaches under the close button. The message uses tabular digits, so a changing count does not move, and with a title the bar's accessible value is the message instead of a bare percentage. It does not time out. Update the existing handle instead of creating one toast per batch. Pass `progress: null` on completion; ordinary duration behavior resumes.

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
