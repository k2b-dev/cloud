### A mobile task view stayed at its first snapshot

- **What happened:** The Cloud app showed assignments and task details from the last open or local write. Changes by other people stayed invisible until the person reopened the page.
- **Root cause:** The mobile view did not subscribe to the existing Space live channel or invalidate its cross-space overview when returning to the foreground. Replacing row objects on refresh also replaced focused controls.
- **Error class:** A server snapshot has no invalidation path for external changes.
- **Guard:** `MyTasks.behavior.test.tsx` checks foreground and online refresh, preserved row identity and focus, and an older response arriving last. `SpacesPwa.behavior.test.tsx` checks live snapshot coverage, resync, foreground refresh, lost access, terminal live recovery and failed reads with retained snapshots. `TaskDetail.behavior.test.tsx` checks that a refreshed snapshot preserves pending edits and the comment draft, then retires settled checklist overlays.
