### Archived run history missed the columns its live twin gained later

- **What happened:** After an upgrade, every Assistant turn on an existing installation failed with `each UNION query
  must have the same number of columns`. Memory learning failed with it. Fresh databases and CI were green.
- **Root cause:** `ai.task_messages` is created once with `CREATE TABLE IF NOT EXISTS … (LIKE ai.messages …)`
  (`packages/cloud/src/ai/migrate.ts`). The delegated chat-done change added three columns only to `ai.messages`. On
  an installation where `ai.task_messages` already existed, the `LIKE` never ran again, so the table kept 24 of 27
  columns. `listTurnMessages` (`packages/cloud/src/ai/store.ts`) read both tables with `SELECT *` in a `UNION ALL`. A
  fresh database creates `ai.task_messages` after the new columns, which is why no test saw the gap.
- **Error class:** A schema change verified only against freshly created state breaks state that an earlier release
  left behind. It is the same class as the 0.69 bar charts that 0.70 rejected
  ([lesson](./2026-11-08-signed-bar-rows-compatibility.md)): earlier state was not part of the test.
- **Guard:** The startup migration adds the columns to `ai.task_messages`, at the point that keeps both tables in the
  same physical order on every upgrade path. Older images that still union with `SELECT *` therefore keep working
  during a rollout or rollback. `listTurnMessages` now names its columns on both sides of the union.
  `task-messages-shape.integration.test.ts` rewinds a migrated database to earlier installations: the first
  `ai.task_messages`, a release before the new columns, the broken intermediate state and a partial one. For each, it
  runs the startup migration twice and requires the same columns, types and order in both tables. It also runs the
  positional union and the turn read. A future `ai.messages` column that does not reach `ai.task_messages` fails this
  test. This is the only table pair in Cloud that is created with `LIKE` and read with `SELECT *`.
