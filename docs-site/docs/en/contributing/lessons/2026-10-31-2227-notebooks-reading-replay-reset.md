### An idle editor ignored the saved text after a workspace replay reset

- **What happened:** An open note could stay stale after reconnecting beyond the workspace event retention window, even though its sidebar refreshed.
- **Root cause:** The server replaces an unavailable replay interval with a workspace invalidation at the current head. The idle editor only refreshed on individual note updates, so another consumer could cover the reset without refreshing the note.
- **Error class:** An invalidation consumer handles individual updates but ignores the covering snapshot required after a replay reset.
- **Guard:** The workspace replay reset regression in `sync-ended.behavior.test.tsx` checks that the idle editor covers the reset by reading and showing saved text without starting collaboration.
