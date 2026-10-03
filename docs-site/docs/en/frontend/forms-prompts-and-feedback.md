---
title: Forms, prompts, and feedback
navTitle: Forms and feedback
section: Frontend
order: 880
description: Collect input and show mutation progress, cancellation, success, and errors.
tags: [forms, prompts, feedback]
updated: 2026-10-03
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

Disable only controls that would start the same conflicting operation. Keep
cancel and navigation available when safe.

Show progress next to the action that started it. Use `ProgressBar` only when
progress is measurable.

Choose one channel per outcome:

- no success message when the result shows where the user acted;
- `toast.success()` when the effect is not on screen, with Undo where it
  exists;
- `toast.error()` with a Retry action when a single action failed and
  repeating it is safe;
- inline field errors for input that blocks a form;
- `prompts.confirm()` before a destructive action, and `prompts.error()`
  only for a failure the user must read and decide on;
- a visible error state for failed content loading.

The [Toast](/en/ui/feedback/toast#use-toast) context explains the rule and
the Retry pattern.

Do not show success before the server confirms the change.

A confirmed write and the read that reconciles its view are separate outcomes.
If the write succeeds but the refresh fails, say that the change was saved and
offer to retry the refresh. Do not label the write as failed or invite a retry
of a completed non-idempotent command.

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
