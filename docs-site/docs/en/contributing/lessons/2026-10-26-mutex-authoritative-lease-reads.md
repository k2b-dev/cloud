### Valid mutex leases rejected after a stale read

- **What happened:** Sync could reject a valid lease extension, causing an IMAP push listener to stop and reconnect.
- **Root cause:** A follower-served KV read could return an older revision. Sync treated the resulting CAS conflict as ownership loss without checking the current owner again.
- **Error class:** Ownership decisions based on eventually consistent reads.
- **Guard:** Sync 7.0.1 uses authoritative stream reads and bounded CAS retries. Its three-node regression suite injects stale revisions after acknowledged extensions and checks replacement owners, expiry, retry bounds, and fencing.
