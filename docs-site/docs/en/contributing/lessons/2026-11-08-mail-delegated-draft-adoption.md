### A delegated first edit must retain the person's provenance

- **What happened:** A suggestion remained untouched after a person's first edit through a delegated credential, allowing a later autonomous replacement.
- **Root cause:** Write admission recognized delegated users, but SQL adoption writes and shared-document event authorship recognized only direct user actors.
- **Error class:** Inconsistent human provenance across mutation and replay paths.
- **Guard:** `draft-suggestions.integration.test.ts` covers delegated first edits in lock and shared modes, attachment changes, recovery, calendar invitations, table actions, and retained publication after SQL rollback. It also preserves service-account access to human-authored drafts.
