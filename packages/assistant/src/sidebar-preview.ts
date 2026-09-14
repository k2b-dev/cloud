import { aiConversations, listAiConversationFiles, listAssistantAiModels } from "@k2b/cloud/ai";
import { artifacts } from "./artifacts/service";

/** Bounded, permission-aware details fetched only when a sidebar preview opens. */
export async function loadAssistantSidebarPreview(userId: string, chatId: string) {
  const conversation = await aiConversations.getConversationByShortId({ shortId: chatId, ownerUserId: userId });
  if (!conversation) return null;
  const [sources, files, turn, models] = await Promise.all([
    aiConversations.listConversationSources({ conversationId: conversation.id, limit: 20 }),
    listAiConversationFiles(conversation.id, userId),
    aiConversations.getLatestTurn({ conversationId: conversation.id }),
    listAssistantAiModels({ type: "user", userId }),
  ]);
  const ids = [...new Set(sources.sources.flatMap((source) => (source.ref?.type === "assistant.artifact" ? [source.ref.id] : [])))];
  const apps = await artifacts.describe(ids, userId, conversation.id);
  return {
    model: turn ? (models.find((model) => model.id === turn.modelProfileId)?.label ?? turn.modelProfileId) : null,
    files: files.map((file) => ({ path: file.path })),
    apps: apps.map((app) => ({ id: app.id, title: app.title, icon: app.icon })),
    hasMoreSources: Boolean(sources.nextCursor),
  };
}
export type AssistantSidebarPreview = NonNullable<Awaited<ReturnType<typeof loadAssistantSidebarPreview>>>;
