import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AiStreamState } from "@k2b/cloud/ai";
import { buildAiMessageTimeline } from "@k2b/cloud/ai/browser";
import { toolCall } from "./acp-updates";
import { createCloudLinkRewriter } from "./cloud-links";
import { terminalSafeModelText } from "./terminal";

/**
 * The editor updates that show a chat's saved history: the window the stream's saved state carries, grouped the way
 * the web chat groups it. The running turn's own steps stay out; following that turn shows them once. With `turn`,
 * only that turn's steps, for a turn that ran when the thread opened and finished before the next message.
 */
export const historyUpdates = (
  state: AiStreamState,
  options: { cwd: string; server: string; chatLink: string; turn?: string },
): SessionUpdate[] => {
  const updates: SessionUpdate[] = [];
  const text = (value: string) => {
    const links = createCloudLinkRewriter(options.server);
    return terminalSafeModelText(links.push(value) + links.flush());
  };
  if (state.hasMoreMessages && !options.turn)
    updates.push({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Earlier messages of this chat are in the web chat: ${options.chatLink}\n\n` },
    });
  const running = state.activeTurn?.turnId;
  for (const item of buildAiMessageTimeline(state.messages)) {
    if (item.type === "summary") continue;
    if (options.turn ? item.type !== "assistant" || item.loopId !== options.turn : false) continue;
    if (item.type === "user") {
      const message = item.entry.message;
      if (message.role !== "user") continue;
      const said = message.content
        .map((part) => (typeof part === "string" ? part : part.type === "text" ? part.text : ""))
        .join("\n")
        .trim();
      if (said) updates.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: text(said) } });
      continue;
    }
    if (running && item.loopId === running) continue;
    for (const block of item.blocks) {
      if (block.kind === "text" && block.text.trim())
        updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${text(block.text)}\n\n` } });
      else if (block.kind === "thinking" && block.text.trim())
        updates.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: text(block.text) } });
      else if (block.kind === "tool") {
        // A finished turn left this call without a saved result; it never runs again.
        const settled =
          block.status === "running" || block.status.startsWith("awaiting")
            ? { ...block, status: "failed" as const, result: block.result ?? { error: "No result was saved for this call." } }
            : block;
        updates.push({ sessionUpdate: "tool_call", ...toolCall(settled, options.cwd) });
      }
    }
  }
  return updates;
};
