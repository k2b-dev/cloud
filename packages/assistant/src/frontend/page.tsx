import {
  aiConversations,
  aiProjects,
  assistantAiSettingsState,
  getAiChatQuotas,
  getLiveDictationStatus,
  loadAiStreamState,
} from "@k2b/cloud/ai";
import { buildAiMessageTimeline, collectAiWakeupLines } from "@k2b/cloud/ai/browser";
import { aiLive } from "@k2b/cloud/ai/live";
import { loadPlaceAssistant } from "@k2b/cloud/ai/server";
import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import type { AuthContext } from "@k2b/cloud/server";
import { auth, expectUserBackedActor, getLocale, getTimeZone, loadPendingApprovals } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import { Layout, loadCodePage, PanelLayout, readPanelContext } from "@k2b/cloud/ssr";
import { getCookie } from "hono/cookie";
import { loadAssistantChatContextSnapshot } from "../chat-context";
import { loadAssistantChatWorkspace } from "../chat-workspace-service";
import { catalogPerApp, loadCodePlace } from "../code-place";
import { type CodeQueryInvoke, hasPersonalCode, loadCodeSummaries } from "../code-summary";
import { chatCodeVersionRefs, loadCodeVersionCards } from "../code-version-cards";
import { ssr } from "../config";
import { loadAssistantProjectContextSnapshot } from "../project-context";
import { chatSecretTitleRefs, loadSecretTitles } from "../secret-titles";
import { loadAssistantSidebarSnapshot, openQuestionsCaller, placeAppsFromCatalog } from "../sidebar";
import { loadWaitingAutomations } from "../waiting-automations";
import AssistantWorkspace from "./AssistantWorkspace.island";
import { readAssistantPlace } from "./assistant-place";
import { ASSISTANT_PANES_HINT_COOKIE } from "./chat-sidebar-layout";
import { loadCodeOverview } from "./code-overview";
import { assistantMessages } from "./messages";
import { describeWakeupLine } from "./wakeup-line";

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
  const [
    settings,
    liveDictation,
    sidebar,
    appUrl,
    initialQuotas,
    approvals,
    codeList,
    codeExists,
    codeBlockPage,
    codeDetail,
    automations,
    placeState,
  ] = await Promise.all([
    assistantAiSettingsState(subject),
    getLiveDictationStatus(c.get("accessSubject")),
    loadAssistantSidebarSnapshot(
      { actor: c.get("actor"), accessSubject: c.get("accessSubject") },
      { locale, timeZone, caller: openQuestionsCaller(c) },
      placeAppsFromCatalog(catalog),
    ),
    coreSettings.get<string>("app.url"),
    getAiChatQuotas(subject).catch(() => null),
    // Only for the view; the sidebar counts what waits from the open questions, like the row above the field.
    approvalsOpen ? loadPendingApprovals(c, { app: "assistant" }) : undefined,
    // The list's first page when the page opens on it; otherwise only whether the person has any Code. Null: unknown.
    codeOpen && !detailCodeId ? loadCodeOverview(invokeCode, owner, { timeZone, now: new Date() }).catch(() => null) : undefined,
    codeOpen && !detailCodeId ? undefined : hasPersonalCode(invokeCode, owner.userId).catch(() => null),
    panelScope ? loadCodeSummaries(invokeCode, { kind: "resource", ref: panelScope }).catch(() => null) : undefined,
    // The shared Code page reads its Code, versions, runs and switch-on state itself and shows each failure in place.
    detailCodeId
      ? loadCodePage(c, { owner: { codeId: detailCodeId }, href: `/app/assistant/code/${detailCodeId}`, canManageOwner: false })
      : undefined,
    // The person's own Code that waits for them, read apart so older questions never push it out of its section.
    approvalsOpen ? loadWaitingAutomations(invokeCode, timeZone).catch(() => null) : undefined,
    // Gustav at a place: the same loader as navigation, so the first paint and a later switch show the same thing.
    panelScope ? loadPlaceAssistant(c, panelScope).catch(() => null) : null,
  ]);
  // An app that does not answer right now leaves the place to the panel, which shows "Try again" in the bar.
  const initialPlace = (() => {
    try {
      return panelScope && placeState ? readAssistantPlace(panelScope, placeState) : null;
    } catch {
      return null;
    }
  })();
  // The panel at a place opens on the person's chat there, unless the address names another one.
  const placeConversationId =
    initialPlace && (initialPlace.state === "available" || initialPlace.state === "unavailable") && !approvalsOpen && !codeOpen
      ? initialPlace.conversationId
      : null;
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
      : (requestedConversationId ??
        (embedded ? placeConversationId : conversations.find((conversation) => !conversation.isDone)?.shortId) ??
        null);
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
  const identity = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
  const [initialDetail, initialTimeline, initialContext, initialTabs] = activeConversation
    ? await Promise.all([
        loadAiStreamState(activeConversation, c.get("actor").kind === "user" ? user.id : null, { locale, userId: user.id }),
        aiConversations.listConversationTimeline({ conversationId: activeConversation.id }),
        loadAssistantChatContextSnapshot({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, activeConversation.shortId, {
          timeZone,
          locale,
        }),
        loadAssistantChatWorkspace(identity, activeConversation.shortId),
      ])
    : [null, [], null, null];

  const [initialCodeVersionCards, initialSecretTitles] = initialDetail
    ? await Promise.all([
        loadCodeVersionCards(invokeCode, chatCodeVersionRefs(initialDetail.messages, initialDetail.activeTurn)),
        loadSecretTitles(invokeCode, chatSecretTitleRefs(initialDetail.messages, initialDetail.activeTurn)),
      ])
    : [[], {}];
  // The chat's alarm lines in words for the first frame; the chat writes them itself once its words loaded.
  const wakeupLines = initialDetail ? collectAiWakeupLines(buildAiMessageTimeline(initialDetail.messages)) : new Map();
  const initialWakeupLines = wakeupLines.size
    ? Object.fromEntries(
        [...wakeupLines].map(([key, line]) => [
          key,
          describeWakeupLine(line, {
            locale,
            timeZone,
            current: initialContext?.wakeups?.items,
            canConfigureAi: user.roles.includes("admin"),
          }),
        ]),
      )
    : undefined;

  const workspace = () => (
    <AssistantWorkspace
      initialCodeVersionCards={initialCodeVersionCards}
      initialSecretTitles={initialSecretTitles}
      embedded={embedded}
      initialPanelContext={panelContext}
      initialPlace={initialPlace}
      initialPlaceChats={sidebar.placeChats ?? null}
      // A chat at a place opens with the list that holds it, so a reload keeps the person where they were.
      initialPlacesFilter={url.searchParams.get("places") === "1" || (!embedded && Boolean(activeConversation?.place))}
      initialQuotas={initialQuotas}
      userId={user.id}
      canConfigureAi={user.roles.includes("admin")}
      cloudUrl={publicCloudOrigin(appUrl)}
      status={status}
      models={status.options}
      timeZone={timeZone}
      renderedAt={new Date().toISOString()}
      initialLiveCursor={initialLiveCursor}
      initialCounts={sidebar.counts}
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
      initialWakeupLines={initialWakeupLines}
      initialTabs={activeConversation && initialTabs ? { chatId: activeConversation.shortId, snapshot: initialTabs } : null}
      arrangeHintSeen={getCookie(c, ASSISTANT_PANES_HINT_COOKIE) === "seen"}
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
      approvals={{ ...(approvals !== undefined ? { page: approvals } : {}), open: approvalsOpen }}
      code={{
        has: hasCode,
        open: codeOpen,
        ...(codeList !== undefined ? { page: codeList } : {}),
        ...(codeDetail ? { detail: codeDetail } : {}),
      }}
      {...(automations !== undefined ? { initialAutomations: automations } : {})}
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
