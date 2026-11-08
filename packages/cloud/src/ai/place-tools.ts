import type { CloudResourceRef } from "../contracts/capabilities";
import type { RequestActor, RequestAuthority } from "../server";
import { resolveAiCapabilityActor } from "./capability-execution";
import { type PlaceProviderOptions, runPlaceProvider } from "./place-provider";
import { aiConversations } from "./store";
import type { AiConversationService, AiStoredMessage } from "./types";

export type AiPlaceToolDependencies = {
  store?: Pick<AiConversationService, "getConversation">;
  getUser?: Parameters<typeof resolveAiCapabilityActor>[0]["getUser"];
  provider?: typeof runPlaceProvider;
  providerOptions?: PlaceProviderOptions;
};

/** A fresh discovery snapshot. Only the stored chat supplies the place; request/model input never does. */
export const resolveAiPlaceTools = async (input: {
  conversationId: string;
  actor: RequestActor;
  locale?: string;
  signal?: AbortSignal;
  dependencies?: AiPlaceToolDependencies;
}): Promise<{ ref: CloudResourceRef; tools: readonly string[] } | null> => {
  const store = input.dependencies?.store ?? aiConversations;
  const conversation = await store.getConversation({ conversationId: input.conversationId });
  if (!conversation?.place) return null;
  try {
    const authority: RequestAuthority = await resolveAiCapabilityActor({
      conversationId: input.conversationId,
      persistedActor: input.actor,
      store,
      getUser: input.dependencies?.getUser,
    });
    const result = await (input.dependencies?.provider ?? runPlaceProvider)(authority, conversation.place.ref, {
      ...input.dependencies?.providerOptions,
      locale: input.locale,
      signal: input.signal,
    });
    return { ref: conversation.place.ref, tools: "unavailable" in result ? [] : result.tools };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return { ref: conversation.place.ref, tools: [] };
  }
};

/** Mark only unresolved historical calls; successful history keeps its original outcome. */
export const rejectUnavailablePlaceCalls = (
  messages: readonly (Pick<AiStoredMessage, "message"> & Partial<Pick<AiStoredMessage, "meta">>)[],
  snapshot: { ref: CloudResourceRef; unavailable: readonly string[]; available: readonly string[] },
  rejected: Set<string>,
): void => {
  const unavailable = new Set(snapshot.unavailable);
  const available = new Set(snapshot.available);
  const settled = new Set(messages.flatMap(({ message }) => (message.role === "tool_result" ? [message.callId] : [])));
  for (const { message, meta } of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "tool_call" || settled.has(block.id)) continue;
      const historicalPlace = meta?.toolPresentations?.[block.id]?.place;
      const wasAtPlace = historicalPlace?.type === snapshot.ref.type && historicalPlace.id === snapshot.ref.id;
      if (unavailable.has(block.name) || (wasAtPlace && !available.has(block.name))) rejected.add(block.id);
    }
  }
};
