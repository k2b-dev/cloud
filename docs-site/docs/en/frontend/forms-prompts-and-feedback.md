---
title: Forms, prompts, and feedback
navTitle: Forms and feedback
section: Frontend
order: 880
description: Collect input and show mutation progress, cancellation, success, and errors.
tags: [forms, prompts, feedback]
updated: 2026-10-15
---

# Forms, prompts, and feedback

Choose the smallest input surface that fits the task.
Follow [Product language and tone](/en/docs/build/product-language-and-tone)
for control labels, validation, confirmations, and recovery messages.

## Choose a prompt

| Need | Use |
| --- | --- |
| Small typed form | `prompts.form()` |
| Confirmation | `prompts.confirm()` |
| Blocking message | `prompts.alert()` or `prompts.error()` |
| Async picker | `prompts.search()` |
| Custom compact content | `prompts.dialog()` |
| Tabbed resource settings | `SettingsModal` in a bare dialog |
| Multi-section editor | `PanelDialog` |

The shared dialog core owns focus, Escape, backdrop, and layering.

## Collect a small form

```tsx
import { prompts } from "@k2b/ui";

const values = await prompts.form({
  title: "Create item",
  fields: {
    name: {
      type: "text",
      label: "Name",
      required: true,
      maxLength: 120,
    },
    quantity: {
      type: "number",
      label: "Quantity",
      min: 0,
      default: 0,
    },
  },
});

if (!values) return;
await createItem.mutate(values);
```

The result is null when the user cancels.

Use Cloud inputs inside custom forms. Reactive values and errors are accessor
functions.

## Show mutation state

Every action answers at once, before its request returns. Either the element
the person acted on changes to the expected result (an optimistic update), or
it shows a visible pending state on itself, such as a busy button or a pending
row. A person who sees nothing happen clicks again or leaves.

| Action | Immediate answer | When the server refuses or the work fails later |
| --- | --- | --- |
| A change the server can reverse that grants no access and exposes no data: a toggle, an inline rename, a move, an archive, a delete to Trash | Apply it optimistically. When the item leaves the view, offer Undo in one notice. | The item returns in its place, and a `toast.error()` names the reason, with a Retry action when repeating the request is safe. An unclear outcome asks the person to check the item instead. |
| A hard delete or another destructive action that cannot be reversed | `prompts.confirm()`, then a pending state on the row until the server answers. No Undo. | The row returns to normal, and the error names the reason. |
| An action that grants a permission or exposes new data, even when it can be reversed: sharing, a permission toggle, a move into a shared folder | A pending state on the acted element until the server answers. | An inline or toast error, as for any failed action. |

A change made in a dialog, such as a rename with name rules, keeps the dialog
open as its pending state until the server answers. An action that cannot be
reversed but destroys nothing, such as sending a message, needs no
confirmation: it keeps a pending state on the acted element until the server
answers, and it offers no Undo.

Offer Undo only where the server can really reverse the action: the item
still exists, for example in Trash, or the server holds the queued command and
can still cancel it. For such an action, Undo may cancel a request the browser
has not sent yet or send the reversing request. Holding a request in the
browser never makes an action eligible for Undo. Do not fake Undo: a row that
only hides while a permanent delete waits in the browser loses the data when
Undo is missed or the page closes. The maintainer decision of 2026-10-13
reads: "Instant feedback: hard deletes keep confirm + pending row, no fake
Undo."

Undo is an action in its own right. It restores the item at once and then
reconciles with the server. If the server refuses or fails the reversal, the
view shows the state the server kept and an error names the reason. Announce
"Undone" only once every reversal was cancelled before sending or accepted by
the server.

When the server refuses an optimistic change or reports its failure, the
item returns in its place. Offer Retry only when repeating the request is
safe: it reuses the idempotency key of the first attempt, or it only sets a
value. When such a request loses its answer, for example to a timeout or a
network error, treat that as a failure: the item returns, and Retry repeats
the same request. When the server reports that it cannot tell whether the
change happened, or a request that is not safe to repeat lost its answer, the
outcome is unclear. Reconcile with the server, ask the person to check the
item, and offer no Retry, because repeating could apply the change twice.

Mail's conversation list is the reference for removal. A deleted or archived
conversation collapses in place, focus moves to the next row, and one notice
offers Undo. If the server refuses the change, the request fails or loses its
answer, or the command fails later, the row comes back in its place with the
reason and a Retry action labeled Try again. After a failed or lost request,
Try again repeats it with the same idempotency key. When it is unclear whether
the mail server made the change, the notice asks the person to check the
conversation and offers no Try again. Actions on the same item run in the
order the person chose them, and a failure of an earlier action never rolls
back a later choice.

Do not drop an action that starts while an earlier one is pending. Disable
only controls that would start a conflicting operation, or queue the action in
order. Keep cancel and navigation available when safe.

When an action uses a pending state, show it on the element that started the
action. Use `ProgressBar` only when progress is measurable.
[Browser clients and mutations](/en/docs/frontend/browser-clients-and-mutations#add-optimistic-state-carefully)
covers capturing, restoring, and reconciling optimistic state.

Choose one channel per outcome:

- no visible success message when the result shows where the user acted;
  call `announce()` from `@k2b/ui` so screen readers hear it when the focused
  control does not say it, for example after a shortcut or when the control
  was replaced;
- `toast.success()` when the effect is not on screen, including an item the
  active filter now hides, with Undo where the server can reverse it;
- `toast.error()` with a Retry action when a single action failed and
  repeating it is safe;
- inline errors for input that blocks a form, and for a failed save from a
  dialog that can stay open until the server answers;
- `prompts.confirm()` before a destructive action that cannot be undone, and
  `prompts.error()` only for a failure the user must read and decide on;
- a visible error state for failed content loading.

The [Toast](/en/ui/feedback/toast#use-toast) context explains the rule and
the Retry pattern.

The changed screen may show a change at once. The Undo notice of an
optimistic, reversible change may appear at once too, because the change can
still be taken back. A message that claims an irreversible outcome, such as
"Sent" or "Deleted permanently", or that grants access or exposes data, such
as "Shared with Alice", waits until the server confirms it.

The server stays authoritative. Reconcile the view with the returned resource
or a refresh after success.

A confirmed write and the read that reconciles its view are separate outcomes.
If the write succeeds but the refresh fails, keep the result on screen, say
that the change was saved, and offer to retry the refresh. Do not label the
write as failed or invite a retry of a completed non-idempotent command.

## Preserve cancellation

Pass the mutation's abort signal into network requests. Route a dialog close
through the same cancellation logic when the operation may still be running.

When a dialog owns unsaved-change protection, use
`cancelBehavior: "ignore"` and provide an accessible guarded close action.

## Server validation remains required

Client validation improves feedback. It does not replace request schema and
domain validation.

Map server field errors back to their inputs when the response provides them.
Keep the original error available for logs and operations.

See [Browser clients and mutations](/en/docs/frontend/browser-clients-and-mutations).
