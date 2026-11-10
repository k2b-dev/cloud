### The Mail composer sent to fewer people than someone typed

- **What happened:** Text left in a recipient field ("bernd", "bernd@firma") disappeared on Send, and the message went only to the other recipients. A pasted list became one invalid entry. A lost upload answer, an unsaved new message, and an inserted link could also vanish or block the composer without a way out.
- **Root cause:** The composer built the message only from committed recipient pills and never asked the fields for their typed text; other paths assumed an answer always arrives or wrote outside the editor's own history.
- **Error class:** Input the person can see but the submit path does not read is dropped silently instead of being committed or blocking the action.
- **Guard:** `packages/mail/src/frontend/_components/MailComposer.behavior.test.tsx` ("MailComposer robustness": unfinished recipient text blocks Send and takes the focus, complete text goes with the message, also through Ctrl+Enter) plus `MailRecipientInput.behavior.test.tsx` (lists split per address) and `mail-composer-attachment-manager.behavior.test.tsx` (a lost finalize answer reconciles once).
