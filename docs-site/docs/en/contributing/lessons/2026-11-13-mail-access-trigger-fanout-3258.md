### Access hints must represent an access or validation change

- **What happened:** Routine sender/template metadata updates and unrelated message unlinking could trigger mailbox-wide shared-draft revalidation.
- **Root cause:** Row triggers treated every sender/template update and message unlink as an access change. Update triggers now compare only validation-relevant columns; message link triggers notify only mailboxes with an editable shared draft referencing that message.
- **Error class:** Broadcasting authorization invalidation for unrelated domain writes.
- **Guard:** `packages/mail/src/service/room-access-events.integration.test.ts` checks committed native PostgreSQL outbox hints for real access changes and checks that metadata, no-op updates, position changes and unrelated message moves/unlinks enqueue none.
