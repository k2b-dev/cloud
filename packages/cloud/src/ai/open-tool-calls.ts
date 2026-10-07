import type { Message, Provider } from "@k2b/nessi";

/** What the model reads for a call of an earlier turn that never returned. */
export const AI_OPEN_TOOL_CALL_RESULT =
  "No result: the turn ended before this call returned, so it may or may not have run. Check its effect before you repeat it.";

/**
 * Gives every call without a result an error result right after the message that made it. A call counts as answered
 * only by a result before the next model message, since some providers reuse call IDs from turn to turn.
 */
const answerOpenCalls = (messages: Message[]): Message[] => {
  let out: Message[] | null = null;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== "assistant") {
      out?.push(message);
      continue;
    }
    const answered = new Set<string>();
    for (let next = index + 1; next < messages.length && messages[next]!.role !== "assistant"; next++) {
      const later = messages[next]!;
      if (later.role === "tool_result") answered.add(later.callId);
    }
    const open = message.content.filter((block) => block.type === "tool_call" && !answered.has(block.id));
    if (open.length > 0) out ??= messages.slice(0, index);
    out?.push(message);
    for (const block of open) {
      if (block.type !== "tool_call") continue;
      out!.push({ role: "tool_result", callId: block.id, name: block.name, result: AI_OPEN_TOOL_CALL_RESULT, isError: true });
    }
  }
  return out ?? messages;
};

/**
 * A turn that was stopped or failed while a call ran or waited for approval leaves that call without a result.
 * Providers reject such a history, so every later turn of the chat would fail, and the model could not tell whether
 * the call ran. The request answers each open call as not returned; the stored history keeps the call as it was, so
 * the chat still shows it as not run. Within a running turn nessi answers every call before the next model call, so
 * only calls of earlier turns are ever open here.
 */
export const answerOpenToolCalls = (provider: Provider): Provider => ({
  name: provider.name,
  family: provider.family,
  model: provider.model,
  contextWindow: provider.contextWindow,
  capabilities: provider.capabilities,
  complete: (request) => provider.complete({ ...request, messages: answerOpenCalls(request.messages) }),
  stream: (request) => provider.stream({ ...request, messages: answerOpenCalls(request.messages) }),
});
