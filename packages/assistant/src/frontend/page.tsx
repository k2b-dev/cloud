import {
  aiConversations,
  aiProjects,
  aiUserPrefs,
  listAiModels,
  loadAiStreamState,
  personalAiModelPolicy,
  toPublicAiSettingsState,
} from "@valentinkolb/cloud/ai";
import { latestAiInvalidationCursor } from "@valentinkolb/cloud/ai/live";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor, getLocale } from "@valentinkolb/cloud/server";
import { coreSettings } from "@valentinkolb/cloud/services";
import { publicCloudOrigin } from "@valentinkolb/cloud/shared";
import { Layout } from "@valentinkolb/cloud/ssr";
import { loadAssistantChatContextSnapshot } from "../chat-context";
import { ssr } from "../config";
import { loadAssistantProjectContextSnapshot } from "../project-context";
import { loadAssistantSidebarSnapshot } from "../sidebar";
import AssistantWorkspace from "./AssistantWorkspace.island";
import { assistantMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const { t } = assistantMessages.resolve([getLocale(c)]);
  const user = expectUserBackedActor(c);
  const url = new URL(c.req.raw.url);
  const requestedConversationId = url.searchParams.get("conversation") ?? undefined;
  const requestedProjectId = url.searchParams.get("project") ?? undefined;
  const initialArtifactPath = url.searchParams.get("artifact");
  const subject = { type: "user" as const, userId: user.id };
  const initialLiveCursor = (await latestAiInvalidationCursor(user.id)) ?? "0-0";
  const [status, models, prefs, sidebar, appUrl] = await Promise.all([
    toPublicAiSettingsState(),
    listAiModels(personalAiModelPolicy),
    aiUserPrefs.get(user.id),
    loadAssistantSidebarSnapshot(user.id),
    coreSettings.get<string>("app.url"),
  ]);
  const { conversations, projects } = sidebar;
  const activeProject = requestedProjectId ? (projects.find((project) => project.shortId === requestedProjectId) ?? null) : null;
  if (requestedProjectId && !activeProject) return c.redirect("/app/assistant", 302);
  const activeProjectRecord = activeProject ? await aiProjects.getByShortId(activeProject.shortId, subject) : null;
  const projectChats = activeProject
    ? await aiConversations.listConversationsPage({
        ownerUserId: user.id,
        projectId: activeProjectRecord!.id,
        page: 1,
        perPage: 20,
      })
    : null;
  const projectContext = activeProject ? await loadAssistantProjectContextSnapshot(subject, activeProject.id) : null;

  const selectedConversationId = activeProject ? null : (requestedConversationId ?? conversations[0]?.shortId ?? null);
  const resolvedActiveConversation = selectedConversationId
    ? await aiConversations.getConversationByShortId({ shortId: selectedConversationId, ownerUserId: user.id })
    : null;
  if (requestedConversationId && resolvedActiveConversation?.shortId !== requestedConversationId) {
    return c.redirect(
      resolvedActiveConversation
        ? `/app/assistant?conversation=${encodeURIComponent(resolvedActiveConversation.shortId)}`
        : "/app/assistant",
      302,
    );
  }
  if (resolvedActiveConversation) {
    await aiConversations.markConversationViewed({
      conversationId: resolvedActiveConversation.id,
      ownerUserId: user.id,
    });
  }
  const activeConversation = resolvedActiveConversation ? { ...resolvedActiveConversation, unreadCompletion: false } : null;
  const initialConversations = conversations.map((conversation) =>
    conversation.id === activeConversation?.shortId ? { ...conversation, unreadCompletion: false } : conversation,
  );
  const [initialDetail, initialTimeline, initialContext] = activeConversation
    ? await Promise.all([
        loadAiStreamState(activeConversation),
        aiConversations.listConversationTimeline({ conversationId: activeConversation.id }),
        loadAssistantChatContextSnapshot(user.id, activeConversation.shortId),
      ])
    : [null, [], null];

  return () => (
    <Layout c={c} fullPage title={[{ title: t.start, href: "/" }, { title: t.assistant }]}>
      <AssistantWorkspace
        cloudUrl={publicCloudOrigin(appUrl)}
        status={status}
        models={models}
        lastModelId={prefs.lastModelId}
        initialLiveCursor={initialLiveCursor}
        initialConversations={initialConversations}
        initialConversationId={activeConversation?.shortId ?? null}
        initialArtifactPath={initialArtifactPath}
        initialDetail={
          initialDetail
            ? {
                conversation: initialDetail.conversation,
                messages: initialDetail.messages,
                hasMoreMessages: initialDetail.hasMoreMessages ?? false,
                activeTurn: initialDetail.activeTurn,
                timeline: initialTimeline,
              }
            : null
        }
        initialContext={initialContext}
        projects={projects}
        initialProject={activeProject}
        initialProjectChats={
          projectChats
            ? {
                ...projectChats,
                items: projectChats.items.map((chat) => ({ ...chat, id: chat.shortId, projectId: activeProject!.id })),
              }
            : null
        }
        initialProjectContext={projectContext}
      />
    </Layout>
  );
});
