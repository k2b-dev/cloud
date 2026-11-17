---
title: Upgrade personal chat queues
navTitle: Chat queue upgrade
section: Operations
order: 1345
description: Preserve existing chat queues while adopting the 20-entry personal queue limit and safe interruption.
tags: [operations, ai, migrations]
updated: 2026-11-15
---

# Upgrade personal chat queues

Upgrade Core and Assistant together so the queue API, client states, and
interruption protocol agree. Startup extends the existing `ai.queued_messages`
table with writer provenance and durable send-now receipts. It reuses the
existing queue, attachment snapshots, workers, and live invalidations.

The existing personal composer queue changes from 32 to 20 pending or failed
entries per chat, using `AI_MESSAGE_QUEUE_LIMIT`.
Existing queues above 20 remain intact and readable. New entries are refused
until fewer than 20 remain; no migration deletes or reorders them. Legacy
entries without provenance are attributed to their chat owner.

Automations as Code will add separate automation capacity: up to 32 entries
per chat and one waiting entry per source (Code or source chat). Those slots
will preserve the person's 20 places. This automation queue comes with
Automations as Code in a later upgrade.

A send-now request is durable before its control signal is published. A worker
finishes its started effect before stopping, and its existing lease heartbeat
recovers missed control delivery. Pending client effects retain the existing
24-hour action-result budget and any earlier turn deadline. Recovery uses the
existing queue sweep; it adds no browser polling or extended timeout.
The existing tool-start and capability-dispatch audit writes also enforce the
barrier, so a missed live signal cannot start another effect. If an orphaned
worker has no durable outcome for a started effect, the entry becomes “Not
sent”; Cloud withdraws that interruption request instead of confirming it.

After the upgrade, verify that an existing queued entry survives a reload and
that sending an entry now yields one user message and one next turn. Check an
uncertain submission by its original entry ID before retrying. See the
[queue API and failure states](/en/docs/ai/chat-runtime-and-streaming#send-a-queued-message-now).

Keep stored `steer_message` and `steer_applied` blocks readable. The CLI's
`turns steer` and its server route remain supported while the Assistant UI uses
send-now. No automation enqueue API, separate automation slots, or `ai.chat.send`
automation capability is registered by this change. Inter-chat delivery keeps
its existing lifecycle and gains source provenance.
