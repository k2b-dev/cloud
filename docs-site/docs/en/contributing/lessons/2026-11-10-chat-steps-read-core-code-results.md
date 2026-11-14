### Failed Code steps in the chat looked like successes

- **What happened:** In a Gustav chat, a refused `code_write`, a check that could not run and a failed `code_test` showed as finished steps without a warning. The phone also showed no version card and could not answer a question.
- **Root cause:** Core's chat tools return their error body as an ordinary result, and the chat recognized failures only for `code_run` and `code_inspect`. Its check outcome read a retired Studio shape. The Cloud app did not pass `renderCodeVersion` and `onFrontendToolResult` to the shared chat.
- **Error class:** A platform view interprets another owner's result shape from hand-made fixtures instead of the owner's real contract.
- **Guard:** `packages/core/src/code/chat-tools.render.test.ts` renders Core's real tool results and contracts through the public `AiTurnBlockView` and fails when a lasting Code tool has no step name. `packages/assistant/src/pwa/AssistantPwa.more.browser.test.ts` checks the version card and a question at phone width.
