### A replacement needs an ordered generation marker

- **What happened:** Switching a collaborative reply between reply-all, forward and reply left the draft unable to freeze for sending.
- **Root cause:** The switch replaced the Yjs state and incremented its SQL generation without publishing the platform generation marker. The retained log head still named the old lineage. Replacement now holds lifecycle-checked document admission, publishes an ordered marker and commits its cursor with the SQL snapshot; rollback restores the old marker.
- **Error class:** Updating a SQL document lineage without its ordered broker fence.
- **Guard:** `packages/mail/src/service/one-reply-draft.integration.test.ts`, “mode switch derives recipients, subject and attachments in both directions (shared)”, checks the actual replacement, freeze, frozen rejection and SQL rollback compensation on real PostgreSQL and JetStream. The two-node load harness's `--mode-switch` scenario reconnects and edits after all three mode transitions.
