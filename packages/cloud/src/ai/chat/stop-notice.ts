import type { AiStoredMessage } from "../types";

export type AiStopNotice = { kind: "output_limit"; reasoning: boolean } | { kind: "stopped" };

/** Silent truncation guard: every non-normal terminal reason has a message-level explanation. */
export function aiMessageStopNotice(entry: AiStoredMessage): AiStopNotice | null {
  if (entry.message.role !== "assistant") return null;
  const reason = entry.stopReason ?? entry.message.stopReason;
  if (!reason || reason === "stop" || reason === "tool_use") return null;
  if (reason === "max_tokens" || reason === "length") {
    const usage = entry.usage ?? entry.message.usage;
    return { kind: "output_limit", reasoning: Boolean(usage && usage.output > 0 && (usage.reasoning ?? 0) / usage.output >= 0.8) };
  }
  return { kind: "stopped" };
}
