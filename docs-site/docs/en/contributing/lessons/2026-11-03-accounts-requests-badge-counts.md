### Every Accounts page read request rows only to show a number

- **What happened:** Fifteen administrator pages in Accounts loaded a page of pending account requests and counted them again, only to show the number on the sidebar badge.
- **Root cause:** The pages reused `accountRequest.list` for the badge instead of a count, so each page view ran two queries and read up to one page of rows.
- **Error class:** A list query used where only a count is needed.
- **Guard:** `groups/page.render.test.tsx` makes `accountRequest.list` reject and still renders the badge from `accountRequest.countPending`.
