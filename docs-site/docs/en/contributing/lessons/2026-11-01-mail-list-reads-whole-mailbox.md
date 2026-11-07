### Opening a large mailbox read every conversation to show one page

- **What happened:** In production, the conversation list query took 3.2 s on average and up to 13 s. The mailbox page took 1.3 s at p50 and 11 s at p95. The largest mailbox holds 46,000 conversations.
- **Root cause:** Under a generic plan, `LIMIT $n` counts as keeping a tenth of the rows, so PostgreSQL chose a hash join and a sort over the whole mailbox instead of reading `conversations_mailbox_latest_idx` in order. Sorting by `CASE WHEN $1 = 'recently_active' ...` and `$1 IS NULL OR ...` filters also rule out the index order. Each conversation's unread folders were computed before the limit too. In a 2,000-conversation fixture the query examined 2,004 rows for one page.
- **Error class:** A paged query whose plan depends on parameter values, so its cost grows with the data and not with the page size.
- **Guard:** `conversation-list-plan.integration.test.ts` runs the query under `plan_cache_mode = force_generic_plan` and fails when the transaction examines more than about a page of conversations (`pg_stat_xact_user_tables`). A plain `EXPLAIN` would not catch this, because it plans with the bound values.
