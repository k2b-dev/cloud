### Contacts exports stopped at 1,000 contacts

- **What happened:** CSV and vCard book exports silently omitted contacts after the first 1,000 ([#1241](https://github.com/k2b-dev/cloud/issues/1241)).
- **Root cause:** The export requested `perPage: 100_000`, which `paginate()` silently clamped to 1,000.
- **Error class:** Silent truncation by a clamped page size.
- **Guard:** `page-size` rejects oversized pagination literals. Contacts unit tests cover keyset cursors, cancellation, serializer bytes, and failed streams; `export.integration.test.ts` checks both downloads with 1,001 contacts.
