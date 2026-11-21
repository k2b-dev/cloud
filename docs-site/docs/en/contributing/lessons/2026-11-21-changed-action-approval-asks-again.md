### An approval for a changed Action failed without a reason

- **What happened:** A chat-code run asked to approve a Capability Action. If the app changed that Action before the person approved, for example during an update, the approval failed with a bare `CONFLICT`. The platform recorded it as a refusal, and the chat showed only that the Code failed. The person got no reason and no way to approve the current version.
- **Root cause:** `resolve` in `packages/assistant/src/chat-code/capability-runtime.ts` threw `CONFLICT` when the schema hash, approval mode or reviewed consequence no longer matched. The host then declined the call for the person.
- **Error class:** A failed asynchronous step that ends in silence instead of a visible state with a way to recover.
- **Guard:** `resolve` returns `changed`, withdraws the call and asks once more with a sentence on the card. Tests in `runner-code-host.test.ts`, `code-approval-message.test.ts` and `service.integration.test.ts` cover the second question, the card text, the withdrawn approval and the bounded retry.
