### Draft fixtures must respect the reply box lifecycle

- **What happened:** Mail integration tests failed before reaching their access and send assertions after reply drafts became unique per conversation.
- **Root cause:** Fixtures created another reply in an occupied conversation and received the existing draft, including a draft already scheduled for sending.
- **Error class:** Test setup retains assumptions from an earlier domain invariant.
- **Guard:** The assigned-access-writes, workspace-list, persistence and sent-projection integration files exercise creation, access and scheduling with one open reply per conversation. Independent cases use separate conversations or finish the previous draft lifecycle; their access assertions remain in place.
