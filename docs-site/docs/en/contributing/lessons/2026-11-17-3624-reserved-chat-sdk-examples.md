### Keep examples aligned with reserved SDK exports

- **What happened:** The scheduled summary test and checked authoring examples could no longer post to a team Chat conversation.
- **Root cause:** Reserving `chat` for the bound Gustav chat moved the Chat application's generated export to `_chat`, while examples still used the former receiver.
- **Error class:** A generated namespace changed without updating its consumers.
- **Guard:** The real checker and fake-bridge fixture tests retain their original capability, destination and idempotency expectations. A combined SDK test verifies that `chat.send` and `_chat.message.post` dispatch to their respective capabilities and targets. The bound-chat AI-tool test also requires the saved-Code checker's fixed-instruction refusal while preserving its low-level target and permission assertions.
