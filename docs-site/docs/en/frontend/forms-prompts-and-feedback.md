---
title: Forms, prompts, and feedback
navTitle: Forms and feedback
section: Frontend
order: 880
description: Collect input and show mutation progress, cancellation, success, and errors.
tags: [forms, prompts, feedback]
updated: 2026-08-28
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

Use:

- inline field errors for invalid input;
- a visible error state for failed content loading;
- `toast.success()` for a completed background action;
- `toast.error()` or `prompts.error()` when a failure needs attention;
- `prompts.confirm()` before a destructive action.

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
