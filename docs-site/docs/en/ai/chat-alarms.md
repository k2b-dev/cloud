---
title: Scheduled chat messages
navTitle: Chat alarms
section: AI
order: 1032
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

The platform mounts these authenticated endpoints under
`/api/ai/conversations/:conversationId/wakeups`. The conversation ID is its
public short ID; alarm IDs are UUIDs. Mutations require a browser session.
GET accepts authenticated credentials and applies the same owner and Project checks.

| Method and suffix | Request | Result |
| --- | --- | --- |
| `GET /` | None | `{ items, limit: 5, paused }` |
| `POST /` | `{ at?, cron?, timezone, endsAt?, note }` | Created alarm |
| `PATCH /:id` | `{ revision, at?, cron?, timezone?, endsAt?, note? }` | Updated alarm |
| `DELETE /:id` | `{ revision }` | Deleted alarm |
| `POST /:id/catch-up` | `{ revision }` | Missed one-off queued as the person's message |

Successful responses return the result directly as JSON. An alarm contains
`id`, `at`, `cron`, `timezone`, `endsAt`, `note`, `noteSource`, `snoozes`, `status`,
`missedReason`, `revision` and `rhythm`. Times are ISO timestamps with an
offset. `at` is the next occurrence or the missed planned time, and null after completion. `rhythm` is
localized display text; show it instead of the cron expression.

Keep the returned `revision` for the next mutation. A stale revision returns
HTTP 409 with `wakeup_conflict`; read the list again. HTTP 400 means invalid
timing or note, 403 means unavailable authority, and 404 means unavailable
chat or alarm. A capacity or snooze refusal returns HTTP 409 with
`wakeup_limit` or `wakeup_snooze_limit`. Catch-up with a full queue returns
HTTP 409 with `wakeup_queue_full` and localized recovery text. Oversized request
bodies return HTTP 413.

There are at most five active or missed alarms and expired recurring alarms per
chat. A completed, deleted or expired one-off releases its place. A note contains at most 200 Unicode
characters. A one-off time must be in the future and no more than one calendar
year ahead. Recurring alarms use five-field cron and an IANA time zone, with
at least 15 minutes between occurrences. Their end defaults to 30 days from
creation and cannot exceed 30 days from the current edit. Renew an expired
alarm by setting `endsAt` within the next 30 days. Set `cron: null` and a new
`at` to make it one-off.

Editing or deleting cancels its pending occurrence. A running turn keeps the normal Stop
control. Deleted alarms cannot be updated; create a new alarm to schedule another reminder.

Alarm messages keep their note in the message bubble. Their source chip shows an
alarm icon and the planned time in the reader's time zone, including after delayed
delivery. Queue and history origins expose this instant as `origin.scheduledAt`
alongside the localized `origin.name`; alarm origins have no source link.

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
alarm prevents another: later occurrences are skipped silently while it waits.
A full automation queue also skips recurring occurrences without adding a timeline
fact. A one-off instead becomes `missed` with reason `queue_full` and one fact.
Alarms use the existing 32 automation queue places.

An archived chat pauses its alarms without moving their next time. Restoring
the chat applies the same single-occurrence recovery. Deleting the chat deletes
its alarms. Stop holds the queue: an alarm can wait there, but cannot release
the hold or start a turn by itself.

The queued message has server-authored `writerOrigin.kind: "wakeup"`, its alarm
ID and `scheduledAt`. Its immutable `turnTrigger` is also `wakeup`. The runtime
projects the queue entry's `origin` and the message's `meta.origin` with
`kind: "wakeup"` and a localized `name` ("Alarm" in English, "Wecker" in German).
The runtime adds planned time, actual time, alarm ID and postponement count to the turn.
The turn runs with the owner's current identity and grants. `noteSource` records
who saved the note: `{ kind: "person", userId }` for a session, or
`{ kind: "gustav", userId, turnId }` for a tool. Updating only its time retains
the note's source; changing its note records the current source. The alarm prompt
frames the note as a previously stored reminder, with this source.

Account, model access and budget refusals before the turn starts create a stored
`meta.wakeupEvent` without a model call. Repeated refusals for the same reason add a fact only on the first transition.
A one-off becomes `missed`; a repeating alarm advances to its next occurrence.
Model access is checked again before execution; a worker model refusal remains
visible through the ordinary failed-turn state. The owner can catch up a missed one-off
once within seven days. Catch-up is a message of the person, so ordinary send
rules apply. After seven days the one-off expires and releases its place. An
expired recurring alarm remains available for renewal.

Unexpected delivery errors retry on minute ticks with 1, 2, 4 and 8 minute delays.
These delays fit the minimum 15-minute alarm interval. A fifth failed attempt
pauses the alarm as `missed`, with `missedReason: "delivery"` and one timeline
fact. Change its time to retry it; missed one-offs also offer ordinary catch-up.
A paused recurring alarm expires after its end time and remains available for renewal.
Cancellation or a lost worker lease does not mark the alarm missed.

Alarm turns share the [automation turn allocation](/en/docs/ai/tools-and-approvals)
and Core's configured Code daily reference limits. The existing Option B
reservation covers the output allowance and one 32k-input call beyond the turn
input allowance. Owner day counters include both Code and alarms. Admission
checks again when a queued message starts; worker admission reserves the actual
model before inference, and ordinary finalization settles it.

Alarm creation, edits, deletion, misses and expiry store timeline facts under
`meta.wakeupEvent`. Each event contains `id`, `kind`, `at` and an alarm snapshot.
Render these as host facts, and use the latest revision for actions. They remain
visible in the chat and are excluded from current and subsequent model context. The existing
conversation live invalidation tells the UI to refresh its authorized snapshot;
live delivery does not read the database.
