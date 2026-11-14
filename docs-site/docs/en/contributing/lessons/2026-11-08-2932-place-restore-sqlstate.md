### Match the database adapter's SQL state before translating a conflict

- **What happened:** Restoring an archived place chat while a replacement was active returned 500 instead of the documented 409.
- **Root cause:** The handler compared `code` with SQL state 23505, but Bun SQL supplies that state in `errno` and uses a separate adapter error code.
- **Error class:** Error translation assumes one database client's error shape.
- **Guard:** Restore uses the existing constraint-aware `isUniqueViolation` helper. Its unit tests cover both adapter shapes; the place store and route integration tests require the conflict and successful restore after archiving the replacement.
