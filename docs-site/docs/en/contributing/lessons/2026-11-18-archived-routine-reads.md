### A sync dropped readers for preserved routine messages

- **What happened:** After sync 61, archived routine messages remained stored, but tool check and turn review reads no longer included them.
- **Root cause:** The sync kept queries against `ai.messages` and lost their `ai.task_messages` branches. The existing transcript regression covered only `listTurnMessages`.
- **Error class:** Archive read coverage lost during conflict resolution.
- **Guard:** `packages/cloud/src/ai/archived-routine-reads.integration.test.ts` exercises both historical readers with archived metadata and pins their SQL statement counts. It also checks conversation and turn isolation, live-check precedence, and that archived routine turns cannot become active. The active-turn reader intentionally excludes routine turns, so its old archive branch is unnecessary; the interactive three-statement budget stays pinned.
