### Preserve domain refusal errors at the room boundary

- **What happened:** Creating a send against a full retained log refused the operation but returned an internal error instead of the existing storage-full conflict.
- **Root cause:** The new pre-transaction room freeze surfaced StoreFullError outside the old SQL document helper. Mail now maps that rejection before command creation, and mode replacement publishes its generation marker before content or attachment changes.
- **Error class:** Losing a domain refusal while replacing its transport boundary.
- **Guard:** `packages/mail/src/service/draft-document-retention.integration.test.ts` preserves the full-log send, table, revision and restore assertions. `one-reply-draft.integration.test.ts`, “full room log refuses a mode generation marker before changing content or attachments”, fills the actual JetStream stream and compares the complete draft and attachment rows.
