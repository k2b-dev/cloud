### Machine workflow authority hung on its own pool and failed in a read-only snapshot

- **What happened:** Grids certification `machine-authority` timed out in two cancellation cases and failed two document-link revocation cases with "cannot execute SELECT FOR SHARE in a read-only transaction".
- **Root cause:** The HTTP authorization cancellation closed its private pool inside the cancel chain while both reserved connections were still held, and `finally` awaited that chain before releasing them. Query captures ran their table authorization, which takes FOR SHARE locks for machine mandates, inside a `READ ONLY` snapshot.
- **Error class:** A cleanup step waits for a resource that only a later cleanup step releases; a lock-taking authority check runs inside a read-only transaction.
- **Guard:** Test: `packages/grids/src/api/workflow-machine-authority.integration.test.ts` (Grids certification phase `machine-authority`) covers request-budget cancellation, registry-read cancellation and revocation during public URL settings for standalone and agent mandates.
