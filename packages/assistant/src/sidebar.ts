import { type AiConversation, type AiOpenQuestions, type AiProject, aiConversations, aiProjects, listAiOpenQuestions } from "@k2b/cloud/ai";

export type AssistantSidebarSnapshot = {
  conversations: AiConversation[];
  projects: AiProject[];
  doneCount: number;
  questions: AiOpenQuestions;
};

export const loadAssistantSidebarSnapshot = async (
  userId: string,
  context: { locale: string; timeZone: string },
): Promise<AssistantSidebarSnapshot> => {
  const subject = { type: "user" as const, userId };
  const [questions, projects, activeConversations, donePage] = await Promise.all([
    listAiOpenQuestions({ ownerUserId: userId, ...context }),
    aiProjects.list(subject),
    aiConversations.listSidebarConversations({ ownerUserId: userId }),
    aiConversations.listConversationsPage({ ownerUserId: userId, done: true, page: 1, perPage: 15 }),
  ]);
  const conversations = [...activeConversations, ...donePage.items];
  const projectShortIds = await aiProjects.resolveShortIds(
    conversations.flatMap((conversation) => (conversation.projectId ? [conversation.projectId] : [])),
    subject,
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
