### The reply box read a lost first-save answer as "no draft"

- **What happened:** In the Mail v5 reply box, the server stored the first draft, but its answer was lost. Discard then sent no `/discard`, so the draft stayed. A mode switch started a second seed and lost newer typing after reopening. Text that met a colleague's reply draft had no recovery offer after reopening. A Discard during a waiting mode switch reopened the discarded draft.
- **Root cause:** The box read the missing answer as a definite "not created". The occupied seed's text sat only under the seed's own journal key. The mode switch went on although the discard owned the composer.
- **Error class:** An operation without a definite answer is treated as failed, and a waiting step goes on after another step took over.
- **Guard:** The draft session repeats the first save with the same idempotency key until its answer is definite, and only then may the seed go. Text in an occupied seed stays in the conversation's buffer and becomes a recovery copy. A mode switch stops when the composer does not release the draft for it. `MailReplyBox.composer.behavior.test.tsx` covers each case.
