### Replies to the mailbox itself must remain editable

- **What happened:** Opening a message addressed only to the mailbox's own identities showed a reply-box error instead of an editor.
- **Root cause:** Recipient derivation correctly excluded the mailbox's own addresses, but draft preparation rejected the empty result as invalid input.
- **Error class:** Applying delivery requirements while preparing an editable draft.
- **Guard:** `reply-self-addressed.test.ts` exercises the public seed service for Reply and Reply all; `reply-recipients.test.ts` covers identity exclusion; `MailReplyBox.composer.behavior.test.tsx` opens an empty-recipient seed and checks the localized refusal to send. `drafts.integration.test.ts` covers persisted replies, saved mode changes, workflow review drafts, and rejection at the send boundary.
