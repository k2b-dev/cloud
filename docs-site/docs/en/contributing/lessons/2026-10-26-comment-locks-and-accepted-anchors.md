### Comment reads fail under contention and accepted suggestions lose their anchors

- **What happened:** Concurrent comment reloads could return busy errors, a slow note blocked comments on other notes, and accepted suggestions appeared orphaned.
- **Root cause:** Reads took a nonblocking advisory lock, all comment operations shared one transaction connection, and accept kept the relative positions of the deleted source text.
- **Error class:** Unnecessary read serialization and stale references after replacement.
- **Guard:** Notebooks `annotations.integration.test.ts` holds a create during replay while concurrent reads and a create on another note complete, and checks the projected ranges after accept and undo. Writes use a waiting per-note lock with a timeout of half the request idle budget and a dedicated pool that allows independent notes to progress.
