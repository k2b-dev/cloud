# Plan time for tasks

Use `spaces.time-block.list` with public `itemId` for one task, or `from` and
`to` for a date-bounded view. A range is optional with `itemId`; if supplied,
include both endpoints within 366 days. Use `mine: true` for the current principal's own planning. Follow every `page.nextCursor`
with the same filters and limit. Read a known UUID with
`spaces.time-block.read`; the ID is a block UUID, not a task ID or dependency.

Create with `spaces.time-block.create` and `{ itemId, taskTitle, id, startsAt, endsAt }`.
Use the exact `taskTitle` from `spaces.item.read` to pin the initial block
title; a concurrent task rename requires a fresh read and review.
Choose an explicit interval with offsets and generate one UUID, retaining it
with the same input for retries. Only the assigned owner can create or change
blocks. People, agents and service accounts can own blocks. A user-delegated
credential acts as its person; an independent account uses its own assignment,
Space access and write scope. Check `canWrite` before editing and `canDelete`
before deleting. Task deletion, lost access or removal from the assignees
prevents edits but still allows the owner to delete their blocks.

For `spaces.time-block.update` or `spaces.time-block.delete`, first read the
block and pass its exact `revision`. Preserve omitted fields. On a conflict,
reread and review the changed state. Each mutation asks for approval. A block
starts with the task title but can have its own title afterwards. Multiple
blocks are independent; completing or deleting a task preserves its blocks.
Deleting a block preserves its task. Never create an event as a substitute for
blocking task time, or add blocks to task dependencies or checklist entries.
Blocks are excluded from iCal and CalDAV. If removing an owner leaves exactly one assignee, blocks move to that
assignee and both receive Cloud notifications. With zero or multiple remaining
assignees, blocks stay with the previous owner, who is notified and may only
delete them. Agent and service-account recipients read their Cloud notices
through `GET /api/notifications/inbox`.

In the CLI, `cld spaces blocks add <task>` requires a client-generated UUID in
`--id`. Reuse it with the same task and interval after a network error or lost
response. `blocks ls <task> --page 1 --per-page 100` returns an array; request pages until empty. Range listing returns a page with
`hasNext` instead.
