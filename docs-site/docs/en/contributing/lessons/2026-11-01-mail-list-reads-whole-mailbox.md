### Opening a large mailbox read every conversation to show one page

- **What happened:** In production, the conversation list query took 3.2 s on average and up to 13 s. The mailbox page took 1.3 s at p50 and 11 s at p95. The largest mailbox holds 46,000 conversations.
- **Root cause:** The query switched filters off with parameters (`$1 IS NULL OR ...`) and sorted by `CASE WHEN $1 = 'recently_active' ...`. A reused generic plan cannot read `conversations_mailbox_latest_idx` in order for such a sort, so it filtered and sorted the whole mailbox before applying `LIMIT`. It also computed each conversation's unread folders before that limit.
- **Error class:** A paged query whose plan depends on parameter values, so its cost grows with the data and not with the page size.
- **Guard:** `conversation-list-plan.integration.test.ts` runs `EXPLAIN ANALYZE` under `plan_cache_mode = force_generic_plan` and fails on a sort or on reading more than about a page of conversations.
