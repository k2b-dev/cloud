import type { AiConversation } from "@k2b/cloud/ai";

type ResolveInitialConversationInput = {
  requestedConversationId?: string;
  conversations: AiConversation[];
  loadConversation: (conversationId: string) => Promise<AiConversation | null>;
};

export const resolveInitialConversation = async (
  input: ResolveInitialConversationInput,
): Promise<{ activeConversation: AiConversation | null; conversations: AiConversation[] }> => {
  if (!input.requestedConversationId) {
    return { activeConversation: input.conversations[0] ?? null, conversations: input.conversations };
  }

  const listed = input.conversations.find((conversation) => conversation.shortId === input.requestedConversationId);
  if (listed) return { activeConversation: listed, conversations: input.conversations };

  const requested = await input.loadConversation(input.requestedConversationId);
  if (!requested) return { activeConversation: input.conversations[0] ?? null, conversations: input.conversations };

  return { activeConversation: requested, conversations: [requested, ...input.conversations] };
};
