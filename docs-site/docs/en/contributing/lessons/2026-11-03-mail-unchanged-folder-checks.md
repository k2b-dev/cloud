### Unchanged folder checks ran a full sync transaction

- **What happened:** Every folder check claimed a resource fence, wrote a sync run, and committed a batch even when IMAP `STATUS` showed nothing new. Each check also read the folder's Drafts role twice. In production, about 1,000 such checks per minute caused most of Mail's idle SQL.
- **Root cause:** The batch claimed its fence before it read the provider, so it could not end early. The commit always ran because that was the only path that refreshed freshness and recovered health.
- **Error class:** Polling that confirms unchanged state through the same write path as a change.
- **Guard:** The idle test in `sync-recovery.integration.test.ts` requires a warmed unchanged batch to finish in 7 PostgreSQL commands with no row writes (24 commands and 5 writes before). It requires at most one sync-time write a minute, a completed run for a folder that a waiting sync command requested, and per-trigger counts. The timeout test still requires a failed run when `STATUS` fails.
