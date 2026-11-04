### Directory maintenance interrupted ordinary grants

- **What happened:** Chat member additions intermittently returned retryable HTTP 409 instead of succeeding or reporting an invalid recipient.
- **Root cause:** `lockAccessMutationAuthority` took directory `SHARE NOWAIT` locks. PostgreSQL autovacuum (`VACUUM ANALYZE auth.groups`, observed through `pg_locks` and `pg_stat_activity`) held the conflicting `ShareUpdateExclusiveLock`, even though no manager authority was changing.
- **Error class:** Immediate authorization-lock conflicts with routine database maintenance.
- **Guard:** Chat integration tests hold the maintenance lock and require one mixed member-add request to succeed within the bounded wait, without a fixture barrier or retry. A concurrent group revocation must instead return 403, leave memberships and messages unchanged, and record the denial. Reverse-order directory writes must finish while a grant waits, with no partial grant locks blocking them. Platform tests check identity contention, shorter timeouts, restored timeout settings and retained authority locks.
