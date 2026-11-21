### A Gustav turn that stopped without any answer was stored as completed

- **What happened:** After its tool calls, a Gustav turn ended with an empty assistant message: `stopReason: stop`,
  no text, and no `turnError`. The turn was stored as `completed`. The completion line in the source chat said that the
  work "is done" without a preview. A Code automation turn left the person with no reason why nothing happened (#3755).
- **Root cause:** `driveChatLoop` in `packages/cloud/src/ai/executor.ts` turned an empty stop into a failure only when
  the round before it had failed (`tool_failed`). After successful steps, the empty stop counted as a normal
  completion. Only the chat view noticed it, after the fact, with its "ended without any text" notice. Every reader of
  the stored turn status, the completion line, and `cld` saw a success.
- **Error class:** A silent ending is detected where it is rendered, not where the turn is finalized. As a result,
  each reader of the stored outcome reports a success that did not happen.
- **Guard:** The executor applies the chat's rule for a silent ending to the whole turn: no text, no result, and no
  Cloud action. Such a turn fails with `provider_stopped` and its localized sentence. `executor.test.ts` checks an
  empty stop after a successful step, and a text written before the step that stays the answer.
