---
title: Mail collaboration capability additions
navTitle: Mail collaboration actions
section: Operations
order: 1198
description: Additional Mail Actions for summaries, explicit work status, individual messages, unassigned claims, and conversation references.
tags: [mail, upgrade, capabilities, cli]
updated: 2026-11-06
---

# Mail collaboration capability additions

This release adds protected summary writes and idempotent reference allocation
to Mail's capability API. It also adds explicit `waiting` and `needs_action`
status writes, revision fences for status batches, an atomic unassigned-only
assignment option, and an exact-message target for move and mark.

These Actions declare the shared silent policy and still enforce current Mail
permissions. They are available to Assistant, CLI, and other capability clients.
Existing move/mark calls without a message target keep changing the whole
conversation; existing `open` status calls keep deriving the next step from
verified mail flow. Existing person-written summaries stay protected from the
new summary Action, including summaries a person cleared.

No database migration, provider configuration, or operator action is required.
The summary response's `source` can now also be `automation`; clients that
validate this enum must accept the new value. The capability schemas advertise
the additional inputs and status values.

See [Mail conversation actions](/en/docs/platform/mail-conversation-actions)
for inputs, conflicts, retry behavior, and CLI examples.
