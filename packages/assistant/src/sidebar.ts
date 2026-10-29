import {
  type AiConversation,
  type AiOpenQuestions,
  type AiProject,
  type AiResourceContext,
  aiConversations,
  aiProjects,
  listAiOpenQuestions,
} from "@k2b/cloud/ai";

export type AssistantSidebarSnapshot = {
  conversations: AiConversation[];
  projects: AiProject[];
  doneCount: number;
  questions: AiOpenQuestions;
};

export const loadAssistantSidebarSnapshot = async (
  identity: AiResourceContext,
  context: { locale: string; timeZone: string },
): Promise<AssistantSidebarSnapshot> => {
  if (identity.accessSubject.type !== "user") throw new Error("A user-backed identity is required.");
  const userId = identity.accessSubject.userId;
  const [questions, projects, activeConversations, donePage] = await Promise.all([
    listAiOpenQuestions({ ownerUserId: userId, ...context }),
    aiProjects.list(identity),
    aiConversations.listSidebarConversations({ ownerUserId: userId }),
    aiConversations.listConversationsPage({ ownerUserId: userId, done: true, page: 1, perPage: 15 }),
  ]);
  const conversations = [...activeConversations, ...donePage.items];
  const projectShortIds = await aiProjects.resolveShortIds(
    conversations.flatMap((conversation) => (conversation.projectId ? [conversation.projectId] : [])),
    identity,
  );
  return {
    questions,
    doneCount: donePage.total,
    projects: projects.map((project) => ({ ...project, id: project.shortId })),
    conversations: conversations.map((conversation) => ({
      ...conversation,
      id: conversation.shortId,
      projectId: conversation.projectId ? (projectShortIds.get(conversation.projectId) ?? null) : null,
    })),
  };
};
