### Preserve human adoption independently of the latest editor

- **What happened:** A service projection could be the latest editor of content that a person had already changed.
- **Root cause:** `last_editor_kind` describes one write and cannot establish whether a draft was ever edited by a person. Publication can also survive a failed SQL transaction.
- **Error class:** Replacing a historical fact with the latest operation's attribution.
- **Guard:** `draft-document-adoption.test.ts` checks retained human provenance, no-op input, service edits and generation changes. `draft-suggestions.integration.test.ts` covers monotonic adoption across content writes, projection after rollback, duplicate creation, pending-send restoration, conflicting conversation merges and distinct offline recovery drafts. `migrate.integration.test.ts` checks the conservative upgrade without changing legacy content or timestamps.
