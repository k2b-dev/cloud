import { type AiConversation, type AiProject, aiConversations, aiProjects } from "@k2b/cloud/ai";

export type AssistantSidebarSnapshot = {
  conversations: AiConversation[];
  projects: AiProject[];
  doneCount: number;
};

export const loadAssistantSidebarSnapshot = async (userId: string): Promise<AssistantSidebarSnapshot> => {
  const subject = { type: "user" as const, userId };
  const [projects, activeConversations, donePage] = await Promise.all([
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
    doneCount: donePage.total,
    projects: projects.map((project) => ({ ...project, id: project.shortId })),
    conversations: conversations.map((conversation) => ({
      ...conversation,
      id: conversation.shortId,
      projectId: conversation.projectId ? (projectShortIds.get(conversation.projectId) ?? null) : null,
    })),
  };
};
