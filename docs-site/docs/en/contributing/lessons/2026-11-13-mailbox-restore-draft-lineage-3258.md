### Restoring a mailbox must preserve an unchanged draft lineage

- **What happened:** A scheduled shared draft became permanently unusable after deleting and restoring its mailbox. Edits and send freezes failed with `GENERATION_CHANGED`.
- **Root cause:** Mailbox cancellation incremented the SQL document generation without replacing content or publishing a platform generation marker. The retained thaw marker still identified the original generation. Cancellation now preserves that generation.
- **Error class:** Changing document identity for a lifecycle transition that does not replace content.
- **Guard:** `packages/mail/src/service/sent-projection.integration.test.ts`, “scheduled shared draft survives mailbox delete and restore, then edits and sends in the same generation”, uses native PostgreSQL and JetStream, the real delete/restore services, provider rediscovery, document admission and send runtime. It checks the unchanged generation, edited command snapshot and one SMTP submission.
