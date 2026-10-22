import { aiConversations } from "./store";
import { publishAiTurnAbort, publishAiWireEvent } from "./stream";
import type { AiTurnAbortRequest } from "./types";

/** Finish a committed cancellation request; shared by interactive and routine cancellation. */
export const finishAiTurnAbort = async (
  input: { conversationId: string; turnId: string },
  request: AiTurnAbortRequest,
  active: Awaited<ReturnType<typeof aiConversations.getActiveTurn>> = null,
): Promise<void> => {
  if (!request.found) return;
  // Tell any live owner to stop (its heartbeat also detects the cancel flag).
  await publishAiTurnAbort(input).catch(() => undefined);

  if (request.ownerless) {
    const finalized = await aiConversations.completeTurn({ ...input, status: "aborted", error: null });
    const config = await aiConversations.getTurnRunConfig(input);
    if (finalized === "completed" && !(config?.kind === "chat" && config.background)) {
      const attempt = active?.turn.id === input.turnId ? active.turn.attempt : 1;
      const seq = (active?.turn.id === input.turnId ? active.liveSeq : 0) + 1;
      await publishAiWireEvent({
        v: 1,
        conversationId: input.conversationId,
        turnId: input.turnId,
        attempt,
        seq,
        type: "turn_finished",
        status: "aborted",
        error: null,
      }).catch(() => undefined);
    }
  }
};
