### Later coverage cannot certify an earlier quarantined snapshot

- **What happened:** Mail drafts quarantined by an older retention reader stayed unreadable after upgrading. Their current cursors and idle coverage looked complete even when earlier input could no longer be proved.
- **Root cause:** Recovery advances the snapshot cursor, and subsequent pruning can advance idle coverage again. Neither value certifies the history before recovery; older releases could also recover repeatedly. The normal recovery-copy restore path requires a writable original and cannot repair a quarantined one.
- **Error class:** Treating a later checkpoint as evidence for an earlier history boundary.
- **Guard:** `draft-quarantine.integration.test.ts` requires the original retained seed and complete topic prefix for strict replay before reopening an original, otherwise creates one linked review copy while retaining the original, source bytes and attachments. It checks stale input, mailbox administration, retry identity, unsettled sends and transport failure before mutation. No migration blindly clears quarantine.
