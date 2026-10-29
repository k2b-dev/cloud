### Assistant map history rejected collection parameters

- **What happened:** The new map persistence integration suite failed to reload or fork a conversation containing a native map with PostgreSQL error `22P02`.
- **Root cause:** The projection passed JavaScript arrays directly to Bun SQL parameters cast to PostgreSQL arrays. That binding did not produce PostgreSQL array literals. JSON strings also lacked the explicit text cast used by the existing message store, allowing JSONB strings instead of objects.
- **Error class:** Driver-specific collection serialization at a database boundary.
- **Guard:** `map-store.integration.test.ts` exercises persisted history, independent forks, interrupted tool recovery, owner isolation, and stale writes against PostgreSQL. The projection uses the existing `toPgTextArray` helper for every array parameter. Snapshot and fork writes cast serialized JSON through text, and the integration suite asserts `jsonb_typeof(snapshot)` is `object`.
