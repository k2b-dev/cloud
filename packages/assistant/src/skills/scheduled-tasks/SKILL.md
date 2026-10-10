---
name: scheduled-tasks
description: Create and manage one-time reminders, delayed jobs and recurring scheduled background tasks in Cloud Assistant. Use for requests such as remind me tomorrow, check in an hour, every morning, or changing, pausing, resuming and repairing a scheduled task, including missing permissions or failed runs.
---

# Schedule reminders and background work

Use this Skill to create or manage a task that runs later, once or repeatedly.
Use the current conversation unless the user names another owned chat. A simple
reminder is a valid task: its result is a normal message in that chat.

## Load the tools for the job

- Create: `core.ai.task.create`.
- Find and inspect: `core.ai.tasks.list`, then `core.ai.task.read`.
- Change instructions, schedule or grants: `core.ai.task.update`.
- Control an existing task: `core.ai.task.pause`, `core.ai.task.resume`,
  `core.ai.task.run`, or `core.ai.task.delete`, as requested.
- Diagnose an occurrence: `core.ai.task.run.read`, using the task and occurrence
  IDs returned by task.read.

Discover and load only the needed capabilities. Read their current input schemas;
reuse returned IDs. Read an existing task before changing it. If the request may
refer to an existing schedule, list tasks before creating a duplicate.

## Prepare the task

1. Resolve the user's timing with the exact runtime timezone (IANA). For a
   one-time reminder or delayed job use kind once and localAt; for recurrence use
   kind cron and cron. Resolve relative wording against the current runtime date
   and time. Ask only if a missing time, timezone or target changes the outcome.
2. Write a self-contained prompt with the intended result, verified resource IDs
   and relevant context. Use normal language for results and problems, without a
   fixed return schema. A reminder prompt says what to remind the user about;
   it needs no app capabilities merely to post its result to this chat.
3. For work across apps, load the relevant domain Skills and discover every
   capability needed, including searches and reads before writes. Propose grants
   for those capabilities. Choose fixedInput fields from their real schemas:
   constrain a specific note when the task targets it; allow a whole notebook or
   unrestricted inputs when that is the intended scope. Empty fixedInput allows
   any inputs within current user access. Do not invent resource IDs or claim a
   notebook constraint exists on an action that accepts only a note ID.
4. Explain the scope through the normal create/update review. Grants authorize
   this task's capability use, not new access to resources. Always-approval
   capabilities cannot be granted. Code Mode can run unattended on the server:
   load its Skill for calculations, chat-file processing, AI tasks and exports.
   Code capability calls inherit this task's grants, including fixed inputs.
   HTTP and RSQL use the same grants list: kind http with fixedInput fields
   origin, url and/or method; kind database with resourceId, operation and/or
   table. Empty fixedInput grants all supported targets/operations within current
   access. Prefer a resourceId-only database grant when a task needs connect and
   multiple operations; a fixed operation also requires a separate connect grant.
   HTTP secrets must already be configured in the chat or app. Interactive dialogs,
   secret entry and capability binary streams are unavailable in scheduled code.
   Explain those requirements instead of promising unattended interaction.
5. Create the task. Confirm its actual saved timing, timezone and destination only
   after success. Queued or manually started does not mean completed.

Examples: “Remind me tomorrow at 09:00 to call Anna” is one once task with no
capability grants. “Every weekday summarize my mail, compare it with calendar X,
and update note Y” is a recurring task with discovered read and write grants,
using verified calendar and note IDs where the respective schemas allow them.

## Changes, errors and missing rights

Read the task and relevant failed run before proposing a repair. Distinguish
missing task grants from lost resource access and ordinary execution errors.
Update the same task's prompt, future schedule or grants; do not recreate it.
Omitted grants remain unchanged; supplied grants replace the complete list.
Expanded authority needs the normal user review and cannot restore lost resource
access. Check writes already performed before retrying with task.run to avoid
duplicates; use task.resume when the user wants future scheduled runs restored.

Each run works independently from a snapshot of the chat history at its start.
Available memories, Skills, Project context and chat files remain accessible
under runtime rules; files are live, not frozen copies. The run returns its result
or problem to the parent chat, reopening it and updating activity. The user can
keep chatting meanwhile. Do not load this management Skill on every background
run unless managing a schedule is itself needed; use the domain Skills for the
actual work.
