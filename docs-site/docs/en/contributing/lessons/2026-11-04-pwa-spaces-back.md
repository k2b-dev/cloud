### Keep Back on the existing history path

- **What happened:** Back from a task added another list entry, so browser Back reopened the task; Chat deep links also added entries when going up.
- **Root cause:** Header navigation pushed the parent address instead of traversing the known list entry or replacing a directly opened detail.
- **Error class:** Parent navigation grows browser history.
- **Guard:** Spaces behavior tests cover list-to-task Back and Forward plus direct task links; Chat behavior tests cover app deep-link fallbacks through chats and threads.
