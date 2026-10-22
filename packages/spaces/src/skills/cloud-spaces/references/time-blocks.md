# Plan time for tasks

Use `spaces.time-block.list` with public `itemId` for one task, or `from` and
`to` for a date-bounded view. A range is optional with `itemId`; if supplied,
include both endpoints within 366 days. Use `mine: true` for the person's own planning. Follow every `page.nextCursor`
with the same filters and limit. Read a known UUID with
`spaces.time-block.read`; the ID is a block UUID, not a task ID or dependency.

Create with `spaces.time-block.create` and `{ itemId, taskTitle, id, startsAt, endsAt }`.
Use the exact `taskTitle` from `spaces.item.read` to pin the initial block
title; a concurrent task rename requires a fresh read and review.
Choose an explicit interval with offsets and generate one UUID, retaining it
with the same input for retries. Only the assigned human owner can create or
change blocks. User-delegated credentials act as that person; independent
agents cannot impersonate people. Check `canWrite` before editing and
`canDelete` before deleting.
After task deletion the owner may delete a block but cannot edit it. Lost
task access or removal from the assignees currently prevents both actions.

For `spaces.time-block.update` or `spaces.time-block.delete`, first read the
block and pass its exact `revision`. Preserve omitted fields. On a conflict,
reread and review the changed state. Each mutation asks for approval. A block
starts with the task title but can have its own title afterwards. Multiple
blocks are independent; completing or deleting a task preserves its blocks.
Deleting a block preserves its task. Never create an event as a substitute for
blocking task time, or add blocks to task dependencies or checklist entries.
Blocks are excluded from iCal and CalDAV. If one owner is replaced by one new
person, blocks move to that person and both receive Cloud notifications.

In the CLI, `cld spaces blocks add <task>` requires a client-generated UUID in
`--id`. Reuse it with the same task and interval after a network error or lost
response. `blocks ls <task> --page 1 --per-page 100` returns an array; request pages until empty. Range listing returns a page with
`hasNext` instead.
