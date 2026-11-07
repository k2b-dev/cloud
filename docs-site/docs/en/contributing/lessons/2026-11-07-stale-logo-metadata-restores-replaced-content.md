### Saving stale logo details restored a replaced mailbox logo

- **What happened:** An administrator saved width or alt text for a mailbox signature logo while another administrator had replaced or removed it. The save re-uploaded the old image and undid the other change (#1477, #1774).
- **Root cause:** Settings sent the logo bytes they had loaded with every details save, and the service accepted them without checking which logo version the edit was based on.
- **Error class:** A metadata edit carries old content along and overwrites a newer version without a precondition.
- **Guard:** The service compares the viewed immutable `versionId` under the mailbox write lock and answers 409. Mail `compose-templates.integration.test.ts` covers stale edits, removals and an expected empty state; `MailboxLogoSettings.behavior.test.tsx` keeps the edits across the conflict and reloads the current image before a retry.
