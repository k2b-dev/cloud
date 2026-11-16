### Discussion container lists were dropped as outside their schema after a sync

- **What happened:** After Sync 53 the preview's discussion sidebar said some places could not be loaded: `book.containers` and `base.containers` results were rejected with "Paginated queries must return page matching their continuation cursor", over 50 times per app.
- **Root cause:** feat/code requires every paginated capability query to return `page` metadata that matches `data.next`; main does not yet, so the container queries added on main (#3484, #3486) returned only `data.next` and the sync kept them as they were.
- **Error class:** A capability written against main's contract that misses a stricter feat/code result contract after a sync.
- **Guard:** Both container queries return `page: capabilityPage(next)`, and their capability tests assert `page` for the continued and the last page; sync conflict notes check new paginated queries for `page`.
