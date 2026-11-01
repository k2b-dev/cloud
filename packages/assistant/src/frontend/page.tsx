import {
  aiConversations,
  aiProjects,
  assistantAiSettingsState,
  getAiChatQuotas,
  getLiveDictationStatus,
  loadAiStreamState,
} from "@k2b/cloud/ai";
import { aiLive } from "@k2b/cloud/ai/live";
import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import type { AuthContext } from "@k2b/cloud/server";
import { auth, expectUserBackedActor, getLocale, getTimeZone, loadPendingApprovals } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import { Layout, loadCodePage, PanelLayout, readPanelContext } from "@k2b/cloud/ssr";
import { getCookie } from "hono/cookie";
import { loadAssistantChatContextSnapshot } from "../chat-context";
import { catalogPerApp, loadCodePlace } from "../code-place";
import {
  type CodePlace,
  type CodeQueryInvoke,
  countOwnRunsSince,
  hasPersonalCode,
  loadCodeAttention,
  loadCodeSummaries,
  startOfDayIn,
} from "../code-summary";
import { ssr } from "../config";
import { loadAssistantProjectContextSnapshot } from "../project-context";
import { loadAssistantSidebarSnapshot } from "../sidebar";
import type { CodeAttentionView } from "./AssistantCodeAttention";
import AssistantWorkspace from "./AssistantWorkspace.island";
import { ASSISTANT_CONTEXT_COOKIE, assistantContextClosedFromCookie } from "./chat-sidebar-layout";
import { assistantMessages } from "./messages";

/** Code that waits for the person, each with its place's name and link, read through the place's own reader. */
const loadCodeAttentionView = async (invoke: CodeQueryInvoke, catalog: ReturnType<typeof catalogPerApp>): Promise<CodeAttentionView> => {
  const page = await loadCodeAttention(invoke);
  const placeOf = async (owner: (typeof page.items)[number]["owner"]): Promise<CodePlace> => {
    if (owner?.kind === "resource") return loadCodePlace(owner.ref, invoke, catalog);
    // Code of an app as a whole: the app's name, without a page to open.
    if (owner?.kind === "app") {
      const app = await catalog(owner.appId).catch(() => null);
      return app?.ok && app.data ? { name: app.data.appName } : {};
    }
    return {};
  };
  return {
    nextCursor: page.nextCursor,
    items: await Promise.all(page.items.map(async (item) => ({ ...item, place: await placeOf(item.owner) }))),
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
  // One personal Code at /app/assistant/code/<codeId>, shown with the shared Code page in the Code view.
  const detailCodeId = c.req.param("codeId");
  if (detailCodeId !== undefined && !/^c_[a-z0-9]{4,16}$/.test(detailCodeId)) return ssr.error(c, 404);
  const codeOpen =
    detailCodeId !== undefined ||
    (!approvalsOpen && url.searchParams.get("code") === "1" && !requestedConversationId && !requestedProjectId);
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
  const catalog = catalogPerApp(locale, auth.getAuthority(c));
  const [settings, liveDictation, sidebar, appUrl, initialQuotas, approvals, codeList, codeExists, codeBlockPage, codeDetail, runsToday, attention] =
    await Promise.all([
      assistantAiSettingsState(subject),
      getLiveDictationStatus(c.get("accessSubject")),
      loadAssistantSidebarSnapshot({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, { locale, timeZone }),
      coreSettings.get<string>("app.url"),
      getAiChatQuotas(subject).catch(() => null),
      // Also without the view: the sidebar shows its Approvals row from the first paint, so it never pushes Studio away.
      loadPendingApprovals(c, { app: "assistant" }),
      // The list's first page when the page opens on it; otherwise only whether the person has any Code. Null: unknown.
      codeOpen && !detailCodeId ? loadCodeSummaries(invokeCode, owner).catch(() => null) : undefined,
      codeOpen && !detailCodeId ? undefined : hasPersonalCode(invokeCode, owner.userId).catch(() => null),
      panelScope ? loadCodeSummaries(invokeCode, { kind: "resource", ref: panelScope }).catch(() => null) : undefined,
      // The shared Code page reads its Code, versions, runs and switch-on state itself and shows each failure in place.
      detailCodeId
        ? loadCodePage(c, { owner: { codeId: detailCodeId }, href: `/app/assistant/code/${detailCodeId}`, canManageOwner: false })
        : undefined,
      // A missing count only leaves the line without numbers.
      codeOpen && !detailCodeId ? countOwnRunsSince(invokeCode, startOfDayIn(timeZone, new Date())).catch(() => null) : undefined,
      approvalsOpen ? loadCodeAttentionView(invokeCode, catalog).catch(() => null) : undefined,
    ]);
  // The panel names its place from the first paint, and knows whether that place could have Code at all.
  const codePlace = panelScope && codeBlockPage !== undefined ? await loadCodePlace(panelScope, invokeCode, catalog) : undefined;
  // An unknown answer keeps "My apps & automations" in the sidebar, so a failure never hides the person's Code.
  const hasCode = codeList !== undefined ? codeList === null || codeList.items.length > 0 : codeExists !== false;
  const status = { ...settings, liveDictationAvailable: liveDictation.available };
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
      code={{
        has: hasCode,
        open: codeOpen,
        ...(codeList !== undefined ? { page: codeList } : {}),
        ...(codeDetail ? { detail: codeDetail } : {}),
        ...(runsToday !== undefined ? { today: runsToday } : {}),
      }}
      {...(attention !== undefined ? { initialAttention: attention } : {})}
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
