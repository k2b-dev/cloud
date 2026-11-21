### Keep independently added migration markers distinct

- **What happened:** Two branches independently assigned Mail schema marker 3 to different changes; their merged runner must accept installations that recorded either history.
- **Root cause:** The per-author suggestion change on main and Mail-rule retirement on the release branch allocated the same primary key in the migration ledger.
- **Error class:** Independent migration histories collide on a shared identifier.
- **Guard:** Keep retirement at 3 and suggestions at 4. The migration moves only the known earlier suggestion marker inside its transaction, preserving its applied timestamp. The full Mail migration integration test checks both resulting markers, preserves the timestamp and repeats startup. The rollback guard refuses suggestion-only rollback after retirement without changing the index or ledger. A separate pre-retirement rollback/re-upgrade test keeps the documented SQL and duplicate demotion covered, including unchanged draft content.
