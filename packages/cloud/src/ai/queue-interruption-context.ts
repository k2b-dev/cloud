import { isUnknownActionOutcome } from "./action-review";
import type { AiStoredMessageOrigin } from "./queue-contracts";
import { isQueueInterruptedResult } from "./turn-interruption";
import type { AiStoredMessage } from "./types";

export type InterruptedStep = { callId: string; name: string; started: boolean };

/** The stored turn remains ordinary history. Only this explanation is a system instruction. */
export const aiQueueInterruptionContext = (input: {
  turnId: string;
  steps: InterruptedStep[];
  messages: AiStoredMessage[];
  todoPlan: unknown;
  origin: AiStoredMessageOrigin;
}): string => {
  const outcomes = new Map(
    input.messages.flatMap(({ message }) => (message.role === "tool_result" ? [[message.callId, message] as const] : [])),
  );
  const completed = input.messages.flatMap(({ message }) => (message.role === "tool_result" ? [message] : []));
  const states = input.steps.map((step) => ({
    callId: step.callId,
    name: step.name,
    state: outcomes.has(step.callId)
      ? isQueueInterruptedResult(outcomes.get(step.callId)?.result)
        ? outcomes.get(step.callId)?.reason === "not_run"
          ? "not_executed"
          : "outcome_unknown"
        : isUnknownActionOutcome(outcomes.get(step.callId)?.result)
          ? "outcome_unknown"
          : "completed"
      : step.started
        ? "outcome_unknown"
        : "not_executed",
  }));
  const lastCompleted = completed.findLast(
    (message) => !isUnknownActionOutcome(message.result) && !isQueueInterruptedResult(message.result),
  );
  return [
    "The preceding turn was interrupted because a queued message was sent now. The interrupted turn and its completed results remain in conversation history.",
    "Handle the following message first. Then decide whether to continue, change or abandon the interrupted work, and explain that decision in one sentence.",
    "Never blindly repeat a step with outcome_unknown; check its real outcome first. Messages still queued are not part of your context.",
    JSON.stringify({
      interruptedTurnId: input.turnId,
      lastCompletedStep: lastCompleted ? { callId: lastCompleted.callId, name: lastCompleted.name } : null,
      stepsAtInterruption: states,
      todoPlan: input.todoPlan ?? null,
      messageOrigin: input.origin,
    }),
  ].join("\n\n");
};
