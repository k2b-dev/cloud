import { aiConversations, aiProjects, assistantAiSettingsState, getAiChatQuotas, loadAiStreamState } from "@k2b/cloud/ai";
import { aiLive } from "@k2b/cloud/ai/live";
import { getCapabilityCatalogApp, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import { type CloudResourceRef, cloudResourceRefAppId, resolveCapabilityResourceReader } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { auth, expectUserBackedActor, getLocale, getTimeZone, loadPendingApprovals } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import { Layout, PanelLayout, readPanelContext } from "@k2b/cloud/ssr";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { loadAssistantChatContextSnapshot } from "../chat-context";
import { type CodeQueryInvoke, hasPersonalCode, loadCodeSummaries } from "../code-summary";
import { ssr } from "../config";
import { loadAssistantProjectContextSnapshot } from "../project-context";
import { loadAssistantSidebarSnapshot } from "../sidebar";
import type { AssistantCodePlace } from "./AssistantCodeBlock";
import AssistantWorkspace from "./AssistantWorkspace.island";
import { ASSISTANT_CONTEXT_COOKIE, assistantContextClosedFromCookie } from "./chat-sidebar-layout";
import { assistantMessages } from "./messages";

const ReaderViewSchema = z.object({ view: z.object({ title: z.string().min(1) }) });

/** The place's name, type and link through its own public reader, so the panel's first paint names it. */
const loadCodePlace = async (
  ref: CloudResourceRef,
  invoke: CodeQueryInvoke,
  catalog: () => ReturnType<typeof getCapabilityCatalogApp>,
): Promise<AssistantCodePlace> => {
  const app = await catalog();
  if (!app.ok || !app.data) return {};
  const reader = resolveCapabilityResourceReader(app.data.manifest, ref);
  if (!reader) return {};
  const read = await invoke({ appId: app.data.appId, capabilityId: reader.localId, kind: "query", input: { id: ref.id } }, z.unknown());
  if (!read.ok) return {};
  const localType = ref.type.slice(app.data.appId.length + 1);
  return {
    name: ReaderViewSchema.safeParse(read.data.data).data?.view.title,
    type: app.data.manifest.types.find((type) => type.localId === localType)?.title ?? app.data.appName,
    href: read.data.links?.find((link) => link.rel === "open")?.href,
  };
};

export default ssr<AuthContext>(async (c) => {
  const embedded = c.req.path === "/app/assistant/panel";
  const basePath = embedded ? "/app/assistant/panel" : "/app/assistant";
  const locale = getLocale(c);
  const timeZone = getTimeZone(c);
  const { t } = assistantMessages.resolve([locale]);
  const user = expectUserBackedActor(c);
  const url = new URL(c.req.raw.url);
  const requestedConversationId = url.searchParams.get("conversation") ?? undefined;
  const requestedProjectId = url.searchParams.get("project") ?? undefined;
  const initialArtifactPath = url.searchParams.get("artifact");
  const approvalsOpen = url.searchParams.get("approvals") === "1" && !requestedConversationId && !requestedProjectId;
  const codeOpen = !approvalsOpen && url.searchParams.get("code") === "1" && !requestedConversationId && !requestedProjectId;
  const panelContext = embedded ? readPanelContext(c) : null;
  // Gustav reads Code through Core's public queries with the person's own credentials, like any application.
  const codeCaller = {
    cookie: c.req.header("cookie"),
    authorization: c.req.header("authorization"),
    locale,
    signal: c.req.raw.signal,
    requestId: c.req.header("x-request-id"),
  };
  const invokeCode: CodeQueryInvoke = (invocation, schema) => invokeCapabilityWithDataSchema(invocation, schema, codeCaller);
  const owner = { kind: "person" as const, userId: user.id };
  const panelScope = panelContext?.scope;
  const subject = { type: "user" as const, userId: user.id };
  const initialLiveCursor = await aiLive.cursor();
  const [status, sidebar, appUrl, initialQuotas, approvals, codeList, codeExists, codeBlockPage] = await Promise.all([
    assistantAiSettingsState(subject),
    loadAssistantSidebarSnapshot({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, { locale, timeZone }),
    coreSettings.get<string>("app.url"),
    getAiChatQuotas(subject).catch(() => null),
    // Also without the view: the sidebar shows its Approvals row from the first paint, so it never pushes Studio away.
    loadPendingApprovals(c, { app: "assistant" }),
    // The list's first page when the page opens on it; otherwise only whether the person has any Code. Null: unknown.
    codeOpen ? loadCodeSummaries(invokeCode, owner).catch(() => null) : undefined,
    codeOpen ? undefined : hasPersonalCode(invokeCode, owner.userId).catch(() => null),
    panelScope ? loadCodeSummaries(invokeCode, { kind: "resource", ref: panelScope }).catch(() => null) : undefined,
  ]);
  // Only a block that shows needs its place's name; failures leave the block without it, as in the browser.
  const codePlace =
    panelScope && codeBlockPage !== undefined && (codeBlockPage === null || codeBlockPage.items.length > 0)
      ? await loadCodePlace(panelScope, invokeCode, () =>
          getCapabilityCatalogApp(cloudResourceRefAppId(panelScope), locale, auth.getAuthority(c)),
        ).catch(() => ({}))
      : undefined;
  // An unknown answer keeps "My apps & automations" in the sidebar, so a failure never hides the person's Code.
  const hasCode = codeOpen ? codeList === null || (codeList !== undefined && codeList.items.length > 0) : codeExists !== false;
  const { conversations } = sidebar;
  const activeProjectRecord = requestedProjectId
    ? await aiProjects.getByShortId(requestedProjectId, { actor: c.get("actor"), accessSubject: c.get("accessSubject") })
    : null;
  if (requestedProjectId && !activeProjectRecord) return ssr.error(c, 404);
  const activeProject = activeProjectRecord ? { ...activeProjectRecord, id: activeProjectRecord.shortId } : null;
  const projects = activeProject
    ? sidebar.projects.some((project) => project.id === activeProject.id)
      ? sidebar.projects.map((project) => (project.id === activeProject.id ? activeProject : project))
      : [...sidebar.projects, activeProject]
    : sidebar.projects;
  const projectChats = activeProjectRecord
    ? await aiConversations.listConversationsPage({
        ownerUserId: user.id,
        projectId: activeProjectRecord.id,
        page: 1,
        perPage: 20,
      })
    : null;
  const projectContext = activeProject ? await loadAssistantProjectContextSnapshot(auth.getAuthority(c), activeProject.id) : null;

  const selectedConversationId =
    activeProject || approvalsOpen || codeOpen
      ? null
      : (requestedConversationId ?? (embedded ? null : conversations.find((conversation) => !conversation.isDone)?.shortId) ?? null);
  const resolvedActiveConversation = selectedConversationId
    ? await aiConversations.getConversationByShortId({ shortId: selectedConversationId, ownerUserId: user.id })
    : null;
  if (!activeProject && requestedConversationId && !resolvedActiveConversation) return ssr.error(c, 404);
  if (requestedConversationId && resolvedActiveConversation?.shortId !== requestedConversationId) {
    return c.redirect(
      resolvedActiveConversation ? `${basePath}?conversation=${encodeURIComponent(resolvedActiveConversation.shortId)}` : basePath,
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
        loadAssistantChatContextSnapshot({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, activeConversation.shortId, {
          timeZone,
        }),
      ])
    : [null, [], null];

  const workspace = () => (
    <AssistantWorkspace
      embedded={embedded}
      initialPanelContext={panelContext}
      initialQuotas={initialQuotas}
      userId={user.id}
      cloudUrl={publicCloudOrigin(appUrl)}
      status={status}
      models={status.options}
      timeZone={timeZone}
      renderedAt={new Date().toISOString()}
      initialLiveCursor={initialLiveCursor}
      initialConversations={initialConversations}
      initialDoneCount={sidebar.doneCount}
      initialQuestions={sidebar.questions}
      initialConversationId={activeConversation?.shortId ?? null}
      initialArtifactPath={initialArtifactPath}
      initialWorkspaceHref={`${url.pathname}${url.search}`}
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
      initialContextClosed={assistantContextClosedFromCookie(getCookie(c, ASSISTANT_CONTEXT_COOKIE))}
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
      approvals={{ page: approvals, open: approvalsOpen }}
      code={{ has: hasCode, open: codeOpen, ...(codeList !== undefined ? { page: codeList } : {}) }}
      initialCodeBlock={panelScope && codeBlockPage !== undefined ? { ref: panelScope, page: codeBlockPage, place: codePlace } : null}
    />
  );
  if (embedded)
    return () => (
      <PanelLayout c={c} title={t.assistant}>
        {workspace()}
      </PanelLayout>
    );
  return () => (
    <Layout c={c} fullPage title={[{ title: t.start, href: "/" }, { title: t.assistant }]}>
      {workspace()}
    </Layout>
  );
});
