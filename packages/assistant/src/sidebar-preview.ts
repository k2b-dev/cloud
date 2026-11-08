import {
  type AiResourceContext,
  aiConversations,
  isAiWorkingFilePath,
  listAiConversationFiles,
  listAssistantAiModels,
} from "@k2b/cloud/ai";

/** Bounded, permission-aware details fetched only when a sidebar preview opens. */
export async function loadAssistantSidebarPreview(identity: AiResourceContext, chatId: string) {
  if (identity.accessSubject.type !== "user") throw new Error("A user-backed identity is required.");
  const userId = identity.accessSubject.userId;
  const conversation = await aiConversations.getConversationByShortId({ shortId: chatId, ownerUserId: userId });
  if (!conversation) return null;
  const [sources, files, turn, models] = await Promise.all([
    aiConversations.listConversationSources({ conversationId: conversation.id, limit: 20 }),
    listAiConversationFiles(conversation.id, userId),
    aiConversations.getLatestTurn({ conversationId: conversation.id }),
    listAssistantAiModels({ type: "user", userId }),
  ]);
  return {
    model: turn ? (models.find((model) => model.id === turn.modelId)?.label ?? turn.modelId) : null,
    // Working files below /temp/ come last, so the preview names what the user brought and received.
    files: [...files.filter((file) => !isAiWorkingFilePath(file.path)), ...files.filter((file) => isAiWorkingFilePath(file.path))].map(
      (file) => ({
        path: file.path,
      }),
    ),
    hasMoreSources: Boolean(sources.nextCursor),
  };
}
export type AssistantSidebarPreview = NonNullable<Awaited<ReturnType<typeof loadAssistantSidebarPreview>>>;
