---
title: Routines became Code
navTitle: Routines became Code
description: Export scheduled Assistant routines before upgrading, then rebuild reviewed personal Code.
section: Operations
order: 95
tags: [routines, code, migration]
updated: 2026-11-07
---

# Routines became Code

Scheduled Assistant chat routines no longer run in this release. Their scheduler,
capabilities, task REST routes, `cld assistant tasks` commands, scheduled-tasks
Skill and routine controls are removed. Restarting Core or restoring a chat cannot
resume an old routine. The public `aiChatTasks`, `AiChatTask*`, `ChatTask*` and
`TaskGrant*` exports are removed too.

## Before upgrading

Use the operator export supplied by the previous release to save routine
definitions before upgrading. Back up the database as well: definition exports
do not include run history or logs. Stop and drain the old Core workers before
starting the upgraded release. A rolling mix of old and new workers is not the
cutover procedure; already dispatched external effects cannot be undone by a migration.

## Rebuild with Gustav

Give Gustav the exported definition and ask for personal Code. Preserve the
prompt, destination chat and explicit IANA time zone. Use `app.schedule` with
`timeZone`, then `core.ai.chat.run` to start a normal owner-authorized chat
turn, or `core.ai.chat.deliver` to post a prepared result without starting AI.
Review the schedule, inputs and
grants before activating the Code. No definition imports authority or activates
a replacement automatically.

A chat turn started by Code follows the owner's current access, model budget and
normal approvals. Approval requests wait in the chat; the scheduling Code can
finish without polling. Old routine HTTP or Studio RSQL grants do not transfer.
Studio database grants are unavailable; no replacement database is provisioned.
See [Code SDK](/en/docs/platform/code-sdk) and
[Code runtime operations](/en/docs/operations/code-runtime).

## Read existing history

Messages already delivered into a chat remain readable, including their original
result, stop and error text. The background-run label is static and offers no
execution control.

Existing `ai.chat_tasks`, `ai.chat_task_occurrences` and `ai.task_messages` rows
remain in the database as a read-only operator archive. The upgrade revokes all
Core `ai.chat-task` mandates, aborts unfinished routine turns and removes their
broker timers. It neither drops history tables nor prunes their logs. Archived
rows retain their original IDs and last recorded state; an `active` definition
in the archive has no execution authority. Each archived definition includes a `retired_mandate` snapshot of its original
authority as historical evidence; the surviving mandate API treats them as opaque, revoked
records. The removed task routes and run browser do not expose this archive.

Deleting a live chat, turn or account no longer cascades into these archive
rows. Include them in the operator's backup, access and retention procedures.
Before a rollback, disable replacement Code schedules; restoring old software
or data must not enable both schedulers for the same occurrence.
