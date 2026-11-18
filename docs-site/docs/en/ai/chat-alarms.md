---
title: Scheduled chat messages
navTitle: Chat alarms
section: AI
order: 1035
description: Schedule Gustav messages in an owned chat and handle missed alarms.
tags: [ai, chat, scheduling]
updated: 2026-11-18
---

# Scheduled chat messages

A Gustav alarm schedules `ai.chat.send` in its owner's chat. It can run once
or repeat. It uses the ordinary chat queue, permission checks and automation
budget. Long-running briefings remain Code automations.

Only the chat owner with unrestricted personal access can manage alarms.
App sessions, delegated credentials, conversations with `allowedTools`, and
Code review turns cannot create them. Shared Project access is checked again
before changes and before execution.

## Create and change alarms

Core mounts these session-authorized endpoints under
`/api/ai/conversations/:conversationId/wakeups`. The conversation ID is its
public short ID; alarm IDs are UUIDs.

| Method and suffix | Request | Result |
| --- | --- | --- |
| `GET /` | None | `{ items, limit: 5, paused }` |
| `POST /` | `{ at?, cron?, timezone, endsAt?, note }` | Created alarm |
| `PATCH /:id` | `{ revision, at?, cron?, timezone?, endsAt?, note? }` | Updated alarm |
| `DELETE /:id` | `{ revision }` | Deleted alarm |
| `POST /:id/catch-up` | `{ revision }` | Missed one-off queued as the person's message |

Successful responses return the result directly as JSON. An alarm contains
`id`, `at`, `cron`, `timezone`, `endsAt`, `note`, `snoozes`, `status`,
`missedReason`, `revision` and `rhythm`. Times are ISO timestamps with an
offset. `at` is the next occurrence or the missed planned time, and null after completion. `rhythm` is
localized display text; show it instead of the cron expression.

Keep the returned `revision` for the next mutation. A stale revision returns
HTTP 409 with `wakeup_conflict`; read the list again. HTTP 400 means invalid
timing or note, 403 means unavailable authority, and 404 means unavailable
chat or alarm. A capacity or snooze refusal returns HTTP 409 with
`wakeup_limit` or `wakeup_snooze_limit`.

There are at most five active, missed or expired alarms per chat. A completed
or deleted alarm releases its place. A note contains at most 200 Unicode
characters. A one-off time must be in the future and no more than one calendar
year ahead. Recurring alarms use five-field cron and an IANA time zone, with
at least 15 minutes between occurrences. Their end defaults to 30 days from
creation and cannot exceed 30 days from the current edit. Renew an expired
alarm by setting `endsAt` within the next 30 days. Set `cron: null` and a new
`at` to make it one-off.

Editing or deleting cancels its pending occurrence. A running turn keeps the normal Stop
control. To undo deletion, patch the returned revision with the saved alarm's
future time, rhythm and note; the five-alarm limit still applies.

## Use alarms from a chat turn

The runtime offers `wakeup_create`, `wakeup_list`, `wakeup_update` and
`wakeup_delete` only in an unrestricted Assistant conversation. Tools bind to
the running chat; they accept no destination chat ID and need no approval card.
Their inputs match the HTTP fields, with `id` on update and delete.

An alarm-triggered turn cannot create another alarm. It may change only the
triggering alarm's time, up to three times in total. It may delete that alarm.
`wakeup_list` also returns that triggering alarm after completion, so the turn
can obtain its latest revision. Ordinary person turns can edit any of their
chat's alarms and reset the postponement count.

## Delivery and recovery

A single minute schedule on the existing Sync scheduler scans at most 100 due
alarms. It queues each occurrence and advances its next time in one transaction.
Each occurrence has a stable send receipt derived from alarm ID and planned
time. Repeated ticks cannot insert it twice. After downtime, a recurring alarm
queues once and moves to its next future time. A pending occurrence of the same
alarm prevents another, and alarms use the existing 32 automation queue places.

An archived chat pauses its alarms without moving their next time. Restoring
the chat applies the same single-occurrence recovery. Deleting the chat deletes
its alarms. Stop holds the queue: an alarm can wait there, but cannot release
the hold or start a turn by itself.

The queued message has server-authored `writerOrigin.kind: "wakeup"`, its alarm
ID and `scheduledAt`. Its immutable `turnTrigger` is also `wakeup`. The runtime
adds planned time, actual time, alarm ID and postponement count to the turn.
The turn runs with the owner's current identity and grants.

A blocked account, unavailable model access or budget refusal creates a stored
`meta.wakeupEvent` without a model call. A one-off becomes `missed`; a repeating
alarm advances to its next occurrence. The owner can catch up a missed one-off
once within seven days. Catch-up is a message of the person, so ordinary send
rules apply. An expired recurring alarm remains available for renewal.

Alarm turns share the [automation turn allocation](/en/docs/ai/tools-and-approvals)
and Core's configured Code daily reference limits. The existing Option B
reservation covers the output allowance and one 32k-input call beyond the turn
input allowance. Owner day counters include both Code and alarms. Admission
checks again when a queued message starts; worker admission reserves the actual
model before inference, and ordinary finalization settles it.

Alarm creation, edits, deletion, misses and expiry store timeline facts under
`meta.wakeupEvent`. Each event contains `id`, `kind`, `at` and an alarm snapshot.
Render these as host facts, and use the latest revision for actions. The existing
conversation live invalidation tells the UI to refresh its authorized snapshot;
live delivery does not read the database.
