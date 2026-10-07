import type { Message, Provider } from "@k2b/nessi";

/** What the model reads for a call of an earlier turn that never returned. */
export const AI_OPEN_TOOL_CALL_RESULT =
  "No result: the turn ended before this call returned, so it may or may not have run. Check its effect before you repeat it.";

/**
 * nessi answers a call without a directly following result with this text before it calls the provider. It does not
 * say whether the call ran, and it leaves a result stored after another message apart from its call. nessi does not
 * export the text; the tests that run a request through nessi fail when it changes.
 */
const NESSI_INTERRUPTED_RESULT = "Tool call was interrupted before it returned a result.";

const isNessiAnswer = (message: Message): boolean =>
  message.role === "tool_result" && message.isError === true && message.result === NESSI_INTERRUPTED_RESULT;

/**
 * Where each call of the model message at `index` has its result: the first result for it before the next user
 * message, or before a later model message with a call of the same ID, since some providers reuse call IDs from turn to
 * turn.
 */
const resultsOf = (messages: readonly Message[], index: number, ids: ReadonlySet<string>): Map<string, number> => {
  const found = new Map<string, number>();
  for (let next = index + 1; next < messages.length && found.size < ids.size; next++) {
    const later = messages[next]!;
    if (later.role === "user") break;
    if (later.role === "assistant" && later.content.some((block) => block.type === "tool_call" && ids.has(block.id))) break;
    if (later.role === "tool_result" && ids.has(later.callId) && !found.has(later.callId)) found.set(later.callId, next);
  }
  return found;
};

/**
 * Gives every call its result right after the message that made it. A call without one gets an error result; a result
 * stored after another model message, such as a scheduled result delivered while the call ran, moves up to its call.
 */
const answerOpenCalls = (request: Message[]): Message[] => {
  // nessi's own answers make way for the result stored apart from the call, or for a clearer answer.
  const messages = request.some(isNessiAnswer) ? request.filter((message) => !isNessiAnswer(message)) : request;
  let out: Message[] | null = null;
  const moved = new Set<number>();
  for (let index = 0; index < messages.length; index++) {
    if (moved.has(index)) continue;
    const message = messages[index]!;
    out?.push(message);
    if (message.role !== "assistant") continue;
    const calls = message.content.flatMap((block) => (block.type === "tool_call" ? [block] : []));
    if (calls.length === 0) continue;
    const results = resultsOf(messages, index, new Set(calls.map((call) => call.id)));
    const late = (at: number) => messages.slice(index + 1, at).some((later) => later.role === "assistant");
    const misplaced = calls.filter((call) => {
      const at = results.get(call.id);
      return at === undefined || late(at);
    });
    if (misplaced.length === 0) continue;
    out ??= messages.slice(0, index + 1);
    for (const call of misplaced) {
      const at = results.get(call.id);
      if (at === undefined) {
        out.push({ role: "tool_result", callId: call.id, name: call.name, result: AI_OPEN_TOOL_CALL_RESULT, isError: true });
      } else {
        out.push(messages[at]!);
        moved.add(at);
      }
    }
  }
  return out ?? messages;
};

/**
 * A turn that was stopped or failed while a call ran or waited for approval leaves that call without a result, and a
 * scheduled result delivered while a call ran is stored between the call and its result. Providers reject such a
 * history, so every later turn of the chat would fail, and the model could not tell whether the call ran. The request
 * answers each open call as not returned and puts each result next to its call; the stored history keeps everything
 * as it was, so the chat still shows an open call as not run. A running turn does not see scheduled results that
 * arrived during it, and nessi answers every call before the next model call, so only earlier turns need this. nessi
 * also answers an open call itself, but neither says that it may have run nor moves a result up to its call.
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
