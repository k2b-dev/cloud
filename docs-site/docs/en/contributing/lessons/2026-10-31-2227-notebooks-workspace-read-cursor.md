### A failed note refresh could be skipped during workspace reconnect

- **What happened:** After a saved-note refresh exhausted its retries, another queued workspace event could advance the reconnect cursor past that failed refresh, leaving the open note stale.
- **Root cause:** The event queue closed its socket on a rejected covering read but kept the same generation until reconnect. Already queued events could still run and acknowledge later cursors.
- **Error class:** A later acknowledgement crosses an uncovered event after a consumer failure.
- **Guard:** `WorkspaceEventBridge.behavior.test.tsx` rejects one covering read with a later event already queued and checks that reconnect keeps the last covered cursor. `reading-note-edit.integration.test.ts` verifies CLI HTTP edits, anchored table actions, direct saved Markdown, same-author delivery, and reconnect replay through the real workspace socket and immediate route-state reads without collaboration or snapshot jobs.
