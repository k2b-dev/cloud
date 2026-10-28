### Preserve lazy SQL array execution in transaction adapters

- **What happened:** A savepoint could report success without executing its returned query array; cancellation could surface an unhandled rejection from an unstarted query.
- **Root cause:** The adapter did not assimilate returned query arrays. Bun also rejects unstarted reserved queries on connection close; their native promises need a rejection observer that does not execute SQL.
- **Error class:** Transaction adapter loses driver execution semantics.
- **Guard:** App-PWA transaction unit and PostgreSQL tests require array execution before release, grouped rollback, no late writes and handled cancellation of unstarted queries. Explicit abort must deliver server cancellation; expiry may be enforced first by PostgreSQL’s bounded statement timeout.
