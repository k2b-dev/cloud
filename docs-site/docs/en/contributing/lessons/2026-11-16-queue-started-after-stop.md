### A stopped chat started its next queued message by itself

- **What happened:** A person stopped Gustav; eight seconds later the queue started the next message, which then waited for an approval, so the chat could not be archived (#108).
- **Root cause:** The queue drain advanced after any end of the current turn, including a person's Stop; archiving refused chats with queued entries, and its conflict named only a running response.
- **Error class:** A person's explicit Stop treated like a normal end of work by automatic follow-up logic.
- **Guard:** `queue-hold.integration.test.ts`: after a Stop no turn starts, also 8 s later; Send now starts exactly one entry; only a new message of the person resumes; archiving lets entries lapse; `routes.integration.test.ts` and `archive-blocker.test.ts` check that archiving names a running response or a waiting decision.
