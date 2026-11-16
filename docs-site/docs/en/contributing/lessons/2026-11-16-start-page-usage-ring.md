### The start page's composer had no usage ring

- **What happened:** In the sixth Preview tour the composer on Gustav's start page showed "+", the model and send, but not the usage ring that v12 places in every composer foot.
- **Root cause:** `Chat.Composer` shows the ring only when there is reported usage or a budget part. A chat that has sent nothing reports no usage, and without a budget set up the ring left its place empty.
- **Error class:** A control that waits for data before it appears, where the design asks for its empty state.
- **Guard:** The Assistant reports zero usage for a chat that has sent nothing, so the ring stands empty. `AssistantComposerUsage.render.test.ts` renders the start page without a budget and expects the ring in the composer's foot.
