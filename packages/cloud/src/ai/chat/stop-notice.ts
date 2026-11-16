import type { AiCodeAuthoringStop, AiStoredMessage } from "../types";

/**
 * The person stopped the turn: its loop ended as aborted, which only the stop request does; without a loop ending, the
 * last message ended as aborted. A turn Cloud ended (a restart, a budget, a time limit) is not stopped by the person.
 */
export const stoppedByPerson = (entries: readonly Pick<AiStoredMessage, "loopDoneReason" | "stopReason">[]): boolean => {
  const loop = entries.findLast((entry) => entry.loopDoneReason)?.loopDoneReason;
  if (loop) return loop === "aborted";
  return entries.findLast((entry) => entry.stopReason)?.stopReason === "aborted";
};

/**
 * `no_answer`: the turn ended normally after its steps but left nothing to read, act on, or explain, such as a model
 * that answers with an empty message. An ending never stays silent, so the chat says so and offers to go on.
 */
export type AiStopNotice =
  | { kind: "code_authoring"; state: AiCodeAuthoringStop }
  | { kind: "output_limit"; reasoning: boolean }
  | { kind: "stopped" }
  | { kind: "no_answer" };

/** Silent truncation guard: every non-normal terminal reason has a message-level explanation. */
export function aiMessageStopNotice(entry: AiStoredMessage): AiStopNotice | null {
  if (entry.message.role !== "assistant") return null;
  if (entry.meta?.codeAuthoringStop) return { kind: "code_authoring", state: entry.meta.codeAuthoringStop };
  const reason = entry.stopReason ?? entry.message.stopReason;
  if (!reason || reason === "stop" || reason === "tool_use") return null;
  if (reason === "max_tokens" || reason === "length") {
    const usage = entry.usage ?? entry.message.usage;
    return { kind: "output_limit", reasoning: Boolean(usage && usage.output > 0 && (usage.reasoning ?? 0) / usage.output >= 0.8) };
  }
  return { kind: "stopped" };
}
