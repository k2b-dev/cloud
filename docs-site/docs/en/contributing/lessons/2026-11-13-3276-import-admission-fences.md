### Bound broker reads under SQL locks and preserve the classified cursor

- **What happened:** A stalled shared-draft import replay could retain a SQL row lock after admission expired. An external replacement could also overwrite room input arriving after import classification.
- **Root cause:** The replay did not receive admission's abort signal, and replacement fetched a newer cursor instead of comparing against the cursor whose events the importer had classified.
- **Error class:** Idle transactions retaining locks; stale validation before a compare-and-set write.
- **Guard:** The sent-projection integration tests `a stalled import replay aborts within admission and releases its SQL row lock` and `provider replacement CAS preserves input arriving after import classification without admission` reproduce both failures. They assert cancellation, rollback, independent `FOR UPDATE NOWAIT` access, preservation of room input, and an external recovery copy.
