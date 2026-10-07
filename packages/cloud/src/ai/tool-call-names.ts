import type { Message, Provider } from "@k2b/nessi";

const UNKNOWN_TOOL_GUIDANCE =
  "Call only tools offered in this turn, by their exact names. Load a deferred tool with load_tools first and call it by the `call` name it returns; load_tools also says why a name cannot be loaded.";

/** nessi answers a call to a name it does not offer with exactly this text. */
const explainUnknownTool = (message: Message): Message =>
  message.role === "tool_result" && message.isError && message.result === `Unknown tool: ${message.name}`
    ? { ...message, result: `Unknown tool: ${message.name}. ${UNKNOWN_TOOL_GUIDANCE}` }
    : message;

/**
 * Lets the model call a loaded app operation by its stable capability ID (#528).
 *
 * Providers only accept provider-safe tool names such as `mail__query__conversation_dot_list`, but
 * models often repeat the ID they loaded, `mail.conversation.list`. A call to the ID of an operation
 * offered in this request is renamed to its provider name before nessi dispatches it, so it runs and is
 * stored under the name the provider accepts. Any other unknown name still fails; the model then reads
 * how to find a callable name instead of a bare "Unknown tool".
 *
 * `canonicalNames` maps provider names to stable names and is read on every call, because the tool
 * resolver replaces its entries before each model turn.
 */
export const acceptCanonicalToolNames = (provider: Provider, canonicalNames: ReadonlyMap<string, string>): Provider => ({
  name: provider.name,
  family: provider.family,
  model: provider.model,
  contextWindow: provider.contextWindow,
  capabilities: provider.capabilities,
  complete: (request) => provider.complete(request),
  stream: async function* (request) {
    const offered = new Set(request.tools?.map((tool) => tool.name));
    const aliases = new Map<string, string>();
    for (const [name, canonicalName] of canonicalNames) {
      if (canonicalName !== name && offered.has(name) && !offered.has(canonicalName)) aliases.set(canonicalName, name);
    }
    const callName = (name: string) => aliases.get(name) ?? name;
    for await (const event of provider.stream({ ...request, messages: request.messages.map(explainUnknownTool) })) {
      if (event.type === "block_start" && event.kind === "tool_call" && event.name) yield { ...event, name: callName(event.name) };
      else if (event.type === "block_end" && event.block.type === "tool_call")
        yield { ...event, block: { ...event.block, name: callName(event.block.name) } };
      else yield event;
    }
  },
});
