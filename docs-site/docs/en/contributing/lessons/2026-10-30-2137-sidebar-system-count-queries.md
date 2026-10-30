### Keep system count classification out of per-chat queries

- **What happened:** Paging a 300-chat sidebar reached the integration test's 30-second timeout after system notification reader checks were added.
- **Root cause:** Each conversation's unread mention count queried system-message membership again, including for empty candidate pages. The sidebar repeated this extra SQL round trip for every row and refresh.
- **Error class:** Per-row query amplification on a bounded list path.
- **Guard:** The existing 300-chat sidebar integration test retains its 30-second timeout, which caught the query amplification in CI. Its new zero-reader assertion separately protects ordinary chats from remote system checks; it does not detect extra SQL. The notification delivery integration test checks that messages sharing a system thread use one reader pair before the snapshot and cached decisions inside it.
