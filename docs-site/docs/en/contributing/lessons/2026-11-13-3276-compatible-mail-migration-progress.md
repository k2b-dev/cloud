### Compatible upgrade progress must survive rolling deployments

- **What happened:** Review caught that the shared-default marker would prevent Cloud 0.76 Mail replicas from restarting, and the migration could overwrite a concurrent explicit lock choice.
- **Root cause:** Compatible progress was stored in an incompatible-schema ledger, and a mailbox cursor could not distinguish old defaults from administrator choices ahead of it.
- **Error class:** Upgrade bookkeeping changes compatibility or overwrites concurrent intent.
- **Guard:** `migrate-shared-drafts.integration.test.ts` asserts the compatibility ledger is unchanged, and tests explicit locks before readiness and ahead of the committed cursor. Compatible progress lives in its own table; explicit PATCH choices have a separate mailbox flag.
