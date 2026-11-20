### A stored browser call result follows the same writer rule as the result itself

- **What happened:** The direct result of a browser code call checked who may write into the turn, but claiming and completing the call did not. A result stored by one session could reach the turn through another window.
- **Root cause:** `authorize()` in `packages/assistant/src/chat-code/client-calls.ts` checked the call, the conversation and the turn, but not whether the requesting session may write into that turn.
- **Error class:** Two routes lead to the same turn effect, and only one of them checks the writer.
- **Guard:** `authorize()` applies `mayWriteIntoAiTurn` before a call starts; `client-calls.test.ts` and `service.integration.test.ts` cover claim and complete from a session that may not write into the turn.
