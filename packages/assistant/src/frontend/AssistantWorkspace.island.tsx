import { ChatPresentation } from "../artifacts/ChatPresentation";
import { resolveChatFileLink } from "./chat-file-link";
import { openAssistantTaskRun } from "./AssistantActivitiesDialog";
import { assistantComposerCommands } from "./composer-commands";
import { type ChatMention, reconcileChatMentions } from "@k2b/ui";
import { consumeCommandLink, registerCommandHandler, registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { ChatComposeInputSchema, assistantCommandMessages } from "../commands";
import AssistantQuota, { createAssistantQuota } from "./AssistantQuota";
import { parseAiTodoPlan } from "@k2b/cloud/ai/browser";
import { browserHttpHost, openSecretsDialog } from "../artifacts/SecretsDialog";
import { createCodeApprovals } from "../artifacts/CapabilityApproval";
import { useAssistantText } from "./ui-copy";
import { CODE_RUNTIME_TOOL_NAMES } from "@k2b/cloud/ai/browser";
import { createAssistantDictation } from "./assistant-dictation";
import { audioMessages } from "./audio-messages";
import { newComposerSession, editComposerSession, observeComposerRevision, confirmComposerSave } from "./composer-session";
import { navigate, navigateTo } from "@k2b/ssr/nav";
import { mutation, query } from "@k2b/stdlib/solid";
import { AppWorkspace, Button, Chat, Dropdown, openSpotlightSearch, prompts, useLocale } from "@k2b/ui";
import type {
  AiConversation,
  AiConversationPage,
  AiConversationTimelineEntry,
  AiProject,
  AiPublicModelProfile,
  AiSettingsError,
  AiStoredMessage,
} from "@k2b/cloud/ai";
import { type AiLiveConnection, createAiChatController, createAiLiveConnection } from "@k2b/cloud/ai/solid";
import {
  AI_COMPOSER_TEXT_MAX_CHARS,
  AI_TURN_ATTACHMENT_MAX_ITEMS,
  AiChatActionsProvider,
  AiChatTurnNavigator,
  type AiComposerAttachment,
  type AiComposerSendInput,
  aiChatAttachments,
  aiChatModelOptions,
  aiComposerAttachmentRecords,
  aiComposerFileAccept,
  aiComposerSendInput,
  aiComposerDraft,
  aiLatestUsageSnapshot,
  createAiChatTimeline,
  createAiPastedTextFile,
  readAiComposerFiles,
  shouldAttachAiPastedText,
} from "@k2b/cloud/ai/ui";
import { cloudResourceClipboard } from "@k2b/cloud/browser/resource-clipboard";
import { openCloudResourcePicker } from "@k2b/cloud/browser/resource-picker";
import { createEffect, createMemo, createSignal, onCleanup, onMount, on, Show } from "solid-js";
import { assistantApi } from "../api/client";
import type { AssistantChatContextSnapshot } from "../chat-context";
import type { AssistantProjectContextSnapshot } from "../project-context";
import type { AssistantSidebarSnapshot } from "../sidebar";
import { AssistantChatContextContent, type ContextCategory, type ContextView, AssistantChatContextPanel } from "./AssistantChatContext";
import { assistantMessageAnchorSeq } from "./message-anchor";
import { assistantSearchOptions } from "./assistant-search";
import { openGlobalSearch, registerSearchNavigation } from "@k2b/cloud/browser/search";
import { resolveAssistantCloudResource } from "./AssistantContextContent";
import AssistantEmptyChat, { type AssistantStarterAction } from "./AssistantEmptyChat";
import { openAssistantCreateProjectDialog } from "./AssistantProjectsDialog";
import AssistantProjectView from "./AssistantProjectView";
import AssistantQueuedMessages, { type AssistantQueuedMessage } from "./AssistantQueuedMessages";
import AssistantSidebar from "./AssistantSidebar";
import {
  type AssistantLiveInvalidation,
  AssistantLiveProvider,
  createAssistantLiveInvalidationHub,
  matchesAssistantInvalidation,
} from "./assistant-live";
import {
  assistantMessageSeqFromHref,
  assistantArtifactHref,
  assistantArtifactPathFromHref,
  assistantConversationHref,
  assistantConversationIdFromHref,
  assistantProjectHref,
  assistantProjectIdFromHref,
} from "./assistant-navigation";
import { submitAssistantProjectMessage } from "./assistant-project-chat";
import { assistantMessages } from "./messages";
import { ArtifactWorkspace, createArtifactWorkspace } from "../artifacts/Workspace";
import { artifactMessages } from "../artifacts/messages";
import { contextTab, appTab, fileTab } from "../artifacts/workspace-state";
import { createArtifactAgentRuntime } from "../artifacts/agent-runtime";

type Status = {
  ok: boolean;
  enabled: boolean;
  defaultModelId: string;
  visionModelConfigured: boolean;
  audioModelConfigured?: boolean;
  error: AiSettingsError | null;
  models: AiPublicModelProfile[];
};

type InitialDetail = {
  conversation: AiConversation;
  messages: AiStoredMessage[];
  hasMoreMessages?: boolean;
  activeTurn: import("@k2b/cloud/ai").AiTurnSnapshot | null;
  timeline?: AiConversationTimelineEntry[];
};

type Props = {
  initialQuotas?: import("@k2b/cloud/shared").AiChatQuotaSnapshot | null;
  userId: string;
  cloudUrl: string;
  status: Status;
  models: AiPublicModelProfile[];
  /** Model of the user's most recent turn (any chat) — preselected for new chats. */
  lastModelId: string;
  initialLiveCursor: string;
  initialConversations: AiConversation[];
  initialDoneCount: number;
  initialConversationId: string | null;
  initialArtifactPath: string | null;
  initialDetail: InitialDetail | null;
  initialContext: AssistantChatContextSnapshot | null;
  projects: AiProject[];
  initialProject: AiProject | null;
  initialProjectChats: AiConversationPage | null;
  initialProjectContext: AssistantProjectContextSnapshot | null;
};

type ProjectViewState = {
  projectId: string;
  page: AiConversationPage;
  context: AssistantProjectContextSnapshot;
};

export default function AssistantWorkspace(props: Props) {
  const locale = useLocale();
  const contextText = useAssistantText();
  const artifactWorkspace = createArtifactWorkspace();
  const openContextView = (view: ContextView) => artifactWorkspace.open(view.context ? contextTab(view.context.conversationId, view.context.category, view.title, view.context.project) : view.file ? { ...fileTab(view.file.conversationId, view.file.path), title: view.title } : { ...view, kind: "view" });
  const [workspaceContext, setWorkspaceContext] = createSignal<AssistantChatContextSnapshot | null>(null);
  const openContextOverview = (category: ContextCategory, title: string) => {
    const chatId = chat.activeConversationId();
    if (!chatId) return;
    const project = activeConversationProject();
    openContextView({ context: { conversationId: chatId, category, project }, key: `${chatId}:${category}`, title, render: () => <AssistantChatContextContent chatId={chatId} project={project} category={category} onOpenView={openContextView} onOpenApp={(id, title, start) => artifactWorkspace.open(appTab(id, title, start))} /> });
  };
  const artifactCopy = () => artifactMessages.resolve([locale()]).t;
  const t = () => assistantMessages.resolve([locale()]).t;
  const contextMenuItems = () => ([
    {label:"Secrets",icon:"ti ti-key",action:()=>{const conversationId=chat.activeConversationId();if(conversationId)void openSecretsDialog({conversationId});}},
    { label: artifactCopy().apps, icon: "ti ti-app-window", action: () => openContextOverview("apps", artifactCopy().apps) },
    { label: artifactCopy().files, icon: "ti ti-files", action: () => openContextOverview("files", artifactCopy().files) },
    { label: contextText("Sources"), icon: "ti ti-link", action: () => openContextOverview("sources", contextText("Sources")) },
    ...(activeConversationProject() ? [{ label: contextText("Project knowledge"), icon: "ti ti-bulb", action: () => openContextOverview("knowledge", contextText("Project knowledge")) }] : []),
    ...(workspaceContext()?.chatId === chat.activeConversationId() && workspaceContext()?.tasks.length ? [{ label: contextText("Scheduled tasks"), icon: "ti ti-calendar-time", action: () => openContextOverview("tasks", contextText("Scheduled tasks")) }] : []),
  ]);
  const audioCopy = () => audioMessages.resolve([locale()]).t;
  const isSelectable = (modelId: string | null | undefined): modelId is string =>
    Boolean(modelId && props.models.some((model) => model.id === modelId));

  const [liveError, setLiveError] = createSignal<string | null>(null);
  let liveConnection: AiLiveConnection | null = null;
  const liveHub = createAssistantLiveInvalidationHub({
    onApplied: (cursor) => {
      setLiveError(null);
      liveConnection?.markApplied(cursor);
    },
    onFailed: (attempt, error) => {
      setLiveError(t().liveRetry);
      if (attempt === 1) console.warn("Assistant live refresh failed", {code:"live_refresh_failed",errorType:error instanceof Error ? error.name : "unknown"});
    },
  });
  liveConnection = createAiLiveConnection({
    initialCursor: props.initialLiveCursor,
    onLiveMessage: (message) => {
      if (message.type === "ai.live.event") liveHub.scheduleEvent(message.payload.cursor, message.payload.event);
      else if (message.type === "ai.live.scope_changed") liveHub.scheduleScopeRefresh();
      else if (message.type === "ai.live.ready" && message.payload.recovered) {
        liveHub.scheduleScopeRefresh(message.payload.cursor);
      }
    },
    onFatal: (error) => setLiveError(error.message),
  });

  const codeApprovals=createCodeApprovals();
  const chat = createAiChatController({
    baseUrl: "/api/ai",
    initialConversationId: props.initialConversationId,
    initialDetail: props.initialDetail,
    initialTimeline: props.initialDetail?.timeline,
    initialError: props.status.error?.message ?? null,
    trackViewedState: true,
    streamTransport: liveConnection.streamTransport,
    clientToolIds: [...CODE_RUNTIME_TOOL_NAMES],
    frontendTools: createArtifactAgentRuntime(artifactWorkspace.open,codeApprovals.ask,"chat-tool",browserHttpHost),
  });

  const quotas = createAssistantQuota(props.initialQuotas);
  createEffect(on(() => chat.running(), () => quotas.refresh(), { defer: true }));

  const sidebar = query.create<string, AssistantSidebarSnapshot, AssistantLiveInvalidation>({
    source: () => "/api/assistant/workspace/sidebar",
    initial: {
      source: "/api/assistant/workspace/sidebar",
      data: { conversations: props.initialConversations, projects: props.projects, doneCount: props.initialDoneCount },
    },
    load: (_source, { abortSignal }) => assistantApi.loadSidebar(abortSignal),
  });
  const conversations = () => sidebar.data()?.conversations ?? props.initialConversations;
  const projects = () => sidebar.data()?.projects ?? props.projects;
  const [projectView, setProjectView] = createSignal<ProjectViewState | null>(
    props.initialProject && props.initialProjectChats && props.initialProjectContext
      ? {
          projectId: props.initialProject.id,
          page: props.initialProjectChats,
          context: props.initialProjectContext,
        }
      : null,
  );
  const activeProject = () => {
    const projectId = projectView()?.projectId;
    return projectId ? (projects().find((project) => project.id === projectId) ?? null) : null;
  };

  const unregisterSidebar = liveHub.register({
    matches: matchesAssistantInvalidation(["conversation-list", "project-list"]),
    invalidate: (invalidation) => sidebar.invalidate(invalidation),
  });
  const unregisterConversation = liveHub.register({
    matches: (invalidation) => {
      if (!invalidation.domains.has("conversation-detail")) return false;
      const conversationId = chat.activeConversationId();
      return Boolean(conversationId && (!invalidation.conversationIds || invalidation.conversationIds.has(conversationId)));
    },
    invalidate: async () => { await Promise.all([chat.refreshActiveConversation(), queuedMessages.refresh()]); },
  });
  onMount(() => liveConnection?.connect());
  onCleanup(() => {
    unregisterSidebar();
    unregisterConversation();
    liveHub.dispose();
    liveConnection?.dispose();
    liveConnection = null;
  });

  // Model selection is per chat: an explicit pick only applies to the chat it
  // was made in. Without a pick, a chat shows the model of its own last
  // assistant turn; new chats start on the user's last-used model.
  const projectComposerKey = (projectId: string) => `project:${projectId}`;
  const [modelChoices, setModelChoices] = createSignal<Record<string, string>>({});
  const modelSessionKey = () => chat.activeConversationId() ?? (activeProject() ? projectComposerKey(activeProject()!.id) : "__new__");
  const modelOfActiveChat = createMemo(() => {
    if (!chat.activeConversationId()) return null;
    const entry = chat
      .messages()
      .findLast((message) => message.kind === "message" && message.message.role === "assistant" && isSelectable(message.modelProfileId));
    return entry?.modelProfileId ?? null;
  });
  const fallbackModelId = () => {
    if (isSelectable(props.lastModelId)) return props.lastModelId;
    if (isSelectable(props.status.defaultModelId)) return props.status.defaultModelId;
    return props.models[0]?.id ?? "";
  };
  const selectedModelId = createMemo(() => {
    const explicit = modelChoices()[modelSessionKey()];
    if (isSelectable(explicit)) return explicit;
    return modelOfActiveChat() ?? fallbackModelId();
  });
  const setSelectedModelId = (modelId: string) => {
    const key = modelSessionKey();
    setModelChoices((current) => ({ ...current, [key]: modelId }));
  };

  const [composerFocusToken, setComposerFocusToken] = createSignal(0);
  const [composerDrafts, setComposerDrafts] = createSignal<Record<string, string>>({});
  const [composerAttachments, setComposerAttachments] = createSignal<Record<string, AiComposerAttachment[]>>({});
  const queuedMessages = query.create({
    source: () => chat.activeConversationId(),
    load: (conversationId, {abortSignal}) => conversationId ? assistantApi.loadQueuedMessages(conversationId, abortSignal) : Promise.resolve([]),
  });
  const [sendingQueuedId, setSendingQueuedId] = createSignal<string | null>(null);
  const [composerSubmitting, setComposerSubmitting] = createSignal(false);
  const [pendingProjectChats, setPendingProjectChats] = createSignal<Record<string, AiConversation>>({});
  const [filesDialogOpen, setFilesDialogOpen] = createSignal(false);
  const [timelineViewport, setTimelineViewport] = createSignal<HTMLDivElement>();
  const [timelineContent, setTimelineContent] = createSignal<HTMLDivElement>();
  let scrollToMessageAnchor: ((anchorId: string | number) => boolean) | undefined;

  let revealRequest = 0;
  const revealMessage = async (messageSeq: number) => {
    const request = ++revealRequest;
    const conversationId = chat.activeConversationId();
    const navigation = navigationRequest;
    const current = () =>
      request === revealRequest && navigation === navigationRequest && !projectView() && conversationId === chat.activeConversationId();
    const unavailable = () => new Error(assistantCommandMessages.resolve([locale()]).t.messageUnavailable);
    if (!(await chat.loadHistoryThroughSeq(messageSeq))) {
      if (current()) throw unavailable();
      return false;
    }
    if (!current()) return false;
    const message = chat.usageMessages().find(item => item.seq === messageSeq);
    if (!message) throw unavailable();
    const seq = assistantMessageAnchorSeq(message, chat.timeline());
    if (!(await chat.loadHistoryThroughSeq(seq))) {
      if (current()) throw unavailable();
      return false;
    }
    if (!current()) return false;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (!current()) return false;
    const anchor = timelineContent()?.querySelector<HTMLElement>(`[data-chat-anchor="${seq}"]`);
    if (!anchor || !scrollToMessageAnchor?.(seq)) {
      throw unavailable();
    }
    anchor.tabIndex = -1;
    anchor.focus({ preventScroll: true });
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      anchor.animate(
        [
          { outline: "2px solid var(--k2b-ai-accent)", outlineOffset: "2px" },
          { outline: "2px solid transparent", outlineOffset: "6px" },
        ],
        { duration: 900, easing: "ease-out" },
      );
    }
    return true;
  };



  const canUseComposer = createMemo(() => props.status.ok && props.status.enabled && props.models.length > 0);
  const usageSnapshot = createMemo(() => aiLatestUsageSnapshot(chat.usageMessages()));
  const usageModel = createMemo(() => {
    const snapshot = usageSnapshot();
    const modelId = snapshot ? snapshot.modelProfileId : selectedModelId();
    return props.models.find((model) => model.id === modelId) ?? null;
  });
  const composerSessionKey = () => chat.activeConversationId() ?? (activeProject() ? projectComposerKey(activeProject()!.id) : "__new__");
  const composerDraft = (key: string) => composerDrafts()[key] ?? "";
  const sessions = new Map<string, ReturnType<typeof newComposerSession>>();
  const [serverDrafts, setServerDrafts] = createSignal<Record<string, AiConversation["draft"]>>({});
  const [sessionVersion, setSessionVersion] = createSignal(0);
  const touchSession = () => setSessionVersion((n) => n + 1);
  const session = (key: string) => {
    let value = sessions.get(key);
    if (!value) {
      value = newComposerSession();
      sessions.set(key, value);
    }
    return value;
  };
  const [composerMentions, setComposerMentions] = createSignal<Record<string, readonly ChatMention[]>>({});
  const mentionsFor = (key: string) => composerMentions()[key] ?? [];
  const setMentionsFor = (key: string, mentions: readonly ChatMention[]) => {
    editComposerSession(session(key));
    setComposerMentions(all => ({ ...all, [key]: mentions }));
  };
  const setComposerDraft = (key: string, value: string) => {
    setMentionsFor(key, reconcileChatMentions(composerDraft(key), value, mentionsFor(key)));
    editComposerSession(session(key));
    setComposerDrafts((current) => ({ ...current, [key]: value }));
  };
  const composerAttachmentsFor = (key: string) => composerAttachments()[key] ?? [];
  const setComposerAttachmentsFor = (key: string, attachments: AiComposerAttachment[]) => {
    editComposerSession(session(key));
    setComposerAttachments((current) => ({ ...current, [key]: attachments }));
  };

  const hydrateComposer = (key: string, draft: AiConversation["draft"]) => {
    const restored = aiComposerDraft(draft.content);
    setComposerDrafts(current => ({ ...current, [key]: restored.text }));
    setComposerAttachments(current => ({ ...current, [key]: restored.attachments }));
    setComposerMentions(current => ({ ...current, [key]: restored.mentions }));
    const local = session(key);
    local.editGeneration++;
    local.baseRevision = draft.revision;
    local.dirty = false;
    local.conflict = false;
    touchSession();
  };
  createEffect(() => {
    const conversation = chat.conversation();
    if (!conversation) return;
    const keys = [
      conversation.id,
      ...Object.entries(pendingProjectChats())
        .filter(([, pending]) => pending.id === conversation.id)
        .map(([projectId]) => projectComposerKey(projectId)),
    ];
    for (const key of keys) {
      setServerDrafts((all) => ({ ...all, [key]: conversation.draft }));
      const existing = sessions.get(key);
      if (!existing || observeComposerRevision(existing, conversation.draft.revision) === "hydrate") {
        hydrateComposer(key, conversation.draft);
      } else if (existing.conflict) touchSession();
    }
  });
  const composerSaves = new Map<string, Promise<unknown>>();
  const serializeComposer = <T,>(key: string, action: () => Promise<T>): Promise<T> => {
    const next = (composerSaves.get(key) ?? Promise.resolve()).then(action, action);
    composerSaves.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  };
  const composerInput = (key: string) =>
    aiComposerSendInput({ intent: "send", text: composerDraft(key), mentions: mentionsFor(key), attachments: aiChatAttachments(composerAttachmentsFor(key)) });
  const saveComposer = (key: string, target: string) =>
    serializeComposer(key, async () => {
      const local = session(key);
      if (local.conflict) return null;
      const generation = local.editGeneration;
      local.saving = true;
      try {
        const saved = await chat.saveDraft({ ...composerInput(key), conversationId: target, expectedDraftRevision: local.baseRevision });
        if (saved) confirmComposerSave(local, saved.revision, generation);
        else {
          local.conflict = true;
          if (chat.activeConversationId() === target) await chat.refreshActiveConversation();
        }
        return saved;
      } finally {
        local.saving = false;
        const remote = serverDrafts()[key];
        if (remote && observeComposerRevision(local, remote.revision) === "hydrate") hydrateComposer(key, remote);
        touchSession();
      }
    });

  const selectedModel = createMemo(() => props.models.find((model) => model.id === selectedModelId()) ?? null);
  const acceptsImages = () =>
    Boolean(
      selectedModel()?.capabilities.includes("vision") ||
        (selectedModel()?.capabilities.includes("tools") && props.status.visionModelConfigured),
    );
  const focusComposer = () => setComposerFocusToken((value) => value + 1);
  const commitConversationUrl = (conversationId: string, replace = false) => {
    const href = assistantConversationHref(window.location.href, conversationId);
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (href === current) return;
    navigate(href, { replace, scroll: "manual", viewTransition: false });
  };
  const newConversation = mutation.create<AiConversation | null, { focus: boolean; projectId?: string; navigate?: boolean }>({
    mutation: async ({ focus, projectId, navigate: shouldNavigate = true }) => {
      const conversation = await chat.createConversation(projectId ? { projectId } : undefined);
      if (conversation && chat.activeConversationId() === conversation.id) {
        if (shouldNavigate) {
          setProjectView(null);
          commitConversationUrl(conversation.id);
        }
        if (focus) focusComposer();
      }
      return conversation;
    },
  });
  const createConversation = async (focus: boolean, projectId?: string, shouldNavigate = true) => {
    if (newConversation.loading()) return null;
    await newConversation.mutate({ focus, projectId, navigate: shouldNavigate });
    return newConversation.data();
  };
  createEffect(() => {
    if (activeProject() || composerSubmitting()) return;
    const key = composerSessionKey();
    const text = composerDraft(key);
    const files = composerAttachmentsFor(key);
    mentionsFor(key);
    if (!session(key).dirty || session(key).conflict) return;
    if (!chat.activeConversationId() && !text && !files.length) return;
    const target = chat.activeConversationId();
    const timer = window.setTimeout(async () => {
      if (composerSessionKey() !== key || session(key).conflict) return;
      let conversationId = target;
      if (!conversationId) {
        const created = await createConversation(false);
        if (!created) return;
        conversationId = created.id;
        setComposerDraft(conversationId, composerDraft(key));
        setComposerAttachmentsFor(conversationId, composerAttachmentsFor(key));
        setMentionsFor(conversationId, mentionsFor(key));
        session(conversationId).baseRevision = created.draft.revision;
      }
      await saveComposer(conversationId, conversationId);
    }, 2_000);
    onCleanup(() => window.clearTimeout(timer));
  });
  const createAndFocusConversation = () => createConversation(true);
  onMount(() => {
    onCleanup(registerCommandHandler("assistant.chat.compose", ChatComposeInputSchema, async input => {
      if (input.projectId && !projects().some(project => project.id === input.projectId)) throw new Error(assistantCommandMessages.resolve([locale()]).t.unavailable);
      const result = await createConversation(true, input.projectId);
      if (!result) throw new Error(assistantCommandMessages.resolve([locale()]).t.failed);
    }));
    void consumeCommandLink();
  });
  createEffect(() => {
    if (newConversation.loading()) return;
    const project = activeProject() ?? projects().find((project) => project.id === activeConversation()?.projectId);
    onCleanup(registerContextAwareCommand({ id: "assistant.chat.compose", title: t().newChat,
      description: project
        ? assistantCommandMessages.resolve([locale()]).t.newProjectChatDescription({ name: project.name })
        : assistantCommandMessages.resolve([locale()]).t.newChatDescription,
      icon: "ti ti-plus", shortcut: "mod+alt+n",
      action: { command: "assistant.chat.compose", input: project ? { projectId: project.id } : {} },
    }));
  });
  const canSend = createMemo(
    () => canUseComposer() && !newConversation.loading() && !chat.loadingConversation() && !chat.running() && !chat.activeTurn(),
  );
  let navigationRequest = 0;
  const openAndFocusConversation = async (conversationId: string) => {
    const requestId = ++navigationRequest;
    setProjectView(null);
    const result = await chat.openConversation(conversationId);
    if (result === "failed") throw new Error(t().openConversationFailed);
    if (result === "stale" || requestId !== navigationRequest) return false;
    if (chat.activeConversationId() === conversationId) focusComposer();
    return true;
  };
  const openProject = async (projectId: string) => {
    const project = projects().find((item) => item.id === projectId);
    if (!project) throw new Error(t().projectNotFound);
    const requestId = ++navigationRequest;
    const [page, context] = await Promise.all([
      assistantApi.listConversationsPage({ projectId, page: 1, perPage: 20 }),
      assistantApi.loadProjectContext(projectId),
    ]);
    if (requestId !== navigationRequest) return false;
    setProjectView({ projectId, page, context });
    return true;
  };
  const filesRefreshKey = createMemo(() => {
    const toolStates =
      chat
        .activeTurn()
        ?.blocks.filter((block) => block.kind === "tool")
        .map((block) => `${block.id}:${block.status}`)
        .join("|") ?? "";
    return `${chat.activeConversationId() ?? ""}:${toolStates}`;
  });
  const openFiles = async (initialPath = "/") => {
    const conversationId = chat.activeConversationId();
    if (conversationId && initialPath !== "/") {
      artifactWorkspace.open(fileTab(conversationId, initialPath));
      return;
    }
    if (!conversationId || filesDialogOpen()) return;
    setFilesDialogOpen(true);
    try {
      openContextOverview("files", artifactCopy().files);
    } finally {
      setFilesDialogOpen(false);
      const href = assistantArtifactHref(window.location.href, null);
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (href !== current) navigate(href, { replace: true, scroll: "manual", viewTransition: false });
      if (artifactWorkspace.mobile() === "chat") focusComposer();
    }
  };

  onMount(() => {
    onCleanup(() => { revealRequest++; navigationRequest++; });
    onCleanup(registerSearchNavigation(async ({ href, ref }) => {
      if (ref?.type !== "assistant.chat" && ref?.type !== "assistant.message") return false;
      const target = new URL(href, props.cloudUrl);
      if (target.origin !== new URL(props.cloudUrl).origin || target.pathname !== "/app/assistant") return false;
      const conversationId = assistantConversationIdFromHref(href);
      if (!conversationId) return false;
      const generation = navigationRequest + 1;
      if (!(await openAndFocusConversation(conversationId))) return true;
      const seq = assistantMessageSeqFromHref(href);
      if (seq !== null && !(await revealMessage(seq))) return true;
      if (navigationRequest === generation && chat.activeConversationId() === conversationId) navigate(href, { scroll: "manual", viewTransition: false });
      return true;
    }));
    const initialMessage = assistantMessageSeqFromHref(window.location.href);
    if (initialMessage !== null) void revealMessage(initialMessage).catch(error => chat.setError(error.message));
    artifactWorkspace.restore();
    const guardUnsaved = (event: BeforeUnloadEvent) => {
      if (artifactWorkspace.hasDirty()) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", guardUnsaved);
    onCleanup(() => window.removeEventListener("beforeunload", guardUnsaved));
    const initialConversationId = chat.activeConversationId();
    if (initialConversationId) commitConversationUrl(initialConversationId, true);
    if (props.initialArtifactPath) requestAnimationFrame(() => void openFiles(props.initialArtifactPath!));

    const handlePopState = () => {
      navigationRequest++;
      artifactWorkspace.restore();
      const conversationId = assistantConversationIdFromHref(window.location.href);
      const projectId = assistantProjectIdFromHref(window.location.href);
      const artifactPath = assistantArtifactPathFromHref(window.location.href);
      const messageSeq = assistantMessageSeqFromHref(window.location.href);
      if (projectId) {
        void openProject(projectId).catch(() => navigateTo("/app/assistant"));
        return;
      }
      if (!conversationId) {
        navigateTo(`${window.location.pathname}${window.location.search}${window.location.hash}`);
        return;
      }
      if (projectView() || conversationId !== chat.activeConversationId()) {
        const generation = navigationRequest + 1;
        void openAndFocusConversation(conversationId).then(async (opened) => {
          if (!opened || navigationRequest !== generation) return;
          if (messageSeq !== null && !(await revealMessage(messageSeq))) return;
          if (navigationRequest === generation && artifactPath) void openFiles(artifactPath);
        }).catch(() => { if (navigationRequest === generation) navigateTo(window.location.href); });
        return;
      }
      if (messageSeq !== null) void revealMessage(messageSeq).catch(error => chat.setError(error.message));
      if (artifactPath) void openFiles(artifactPath);
    };
    window.addEventListener("popstate", handlePopState);
    onCleanup(() => window.removeEventListener("popstate", handlePopState));
  });

  const send = async (input: AiComposerSendInput) => {
    if (!canSend() || dictation.busy()) return false;
    dictation.invalidateAutomatic();
    setComposerSubmitting(true);
    try {
      if (!chat.activeConversationId()) {
        const conversation = await createConversation(false);
        if (!conversation || chat.activeConversationId() !== conversation.id) return false;
        session(conversation.id).baseRevision = conversation.draft.revision;
      }
      const target = chat.activeConversationId()!;
      const sent = await serializeComposer(target, async () => {
        const local = session(target);
        if (local.conflict) return false;
        local.saving = true;
        try {
          const result = await chat.send({
            ...input,
            conversationId: target,
            expectedDraftRevision: local.baseRevision,
            modelProfileId: selectedModelId() || undefined,
          });
          const draft = chat.conversation()?.id === target ? chat.conversation()?.draft : undefined;
          if (draft) local.baseRevision = draft.revision;
          if (!result) local.conflict = true;
          return result;
        } finally {
          local.saving = false;
          touchSession();
        }
      });
      return sent;
    } finally {
      setComposerSubmitting(false);
    }
  };
  const sendProjectMessage = async (projectId: string, input: AiComposerSendInput) => {
    if (!canSend() || dictation.busy()) return false;
    dictation.invalidateAutomatic();
    const modelProfileId = selectedModelId() || undefined;
    return submitAssistantProjectMessage({
      projectId,
      message: input,
      modelProfileId,
      pendingConversation: pendingProjectChats()[projectId],
      activeConversationId: chat.activeConversationId,
      openConversation: chat.openConversation,
      createConversation: (targetProjectId) => createConversation(false, targetProjectId, false),
      send: (message) => {
        const target = chat.activeConversationId();
        if (!target) return Promise.resolve(false);
        const key = projectComposerKey(projectId);
        return serializeComposer(key, async () => {
          const local = session(key);
          if (local.conflict) return false;
          local.saving = true;
          try {
            const sent = await chat.send({ ...message, conversationId: target, expectedDraftRevision: local.baseRevision });
            const draft = chat.conversation()?.draft;
            if (draft) local.baseRevision = draft.revision;
            if (!sent) local.conflict = true;
            return sent;
          } finally {
            local.saving = false;
            touchSession();
          }
        });
      },
      rememberPending: (conversation) => setPendingProjectChats((current) => ({ ...current, [projectId]: conversation })),
      clearPending: () =>
        setPendingProjectChats((current) => {
          const next = { ...current };
          delete next[projectId];
          return next;
        }),
      navigate: (conversationId) => navigateTo(assistantConversationHref(window.location.href, conversationId)),
    });
  };
  const steer = async (message: string) => {
    if (!canUseComposer() || !chat.activeTurn()) return false;
    return chat.steer(message);
  };

  const queuedMessagesFor = (conversationId: string): AssistantQueuedMessage[] =>
    conversationId === chat.activeConversationId() ? (queuedMessages.data() ?? []).map(message => ({
      ...message, editableText:aiComposerDraft(message.content).text, text:message.content.map(part => part.type === "text" ? part.text : (part.type === "file" || part.type === "project-file") ? part.path : part.title ?? part.ref.id).join(" · "),
    })) : [];
  const queueMessage = async (input: AiComposerSendInput) => {
    const conversationId = chat.activeConversationId();
    if (!conversationId || composerSubmitting()) return false;
    setComposerSubmitting(true);
    try {
      return await serializeComposer(conversationId, async () => {
        const local = session(conversationId);
        if (local.conflict) return false;
        local.saving = true;
        try {
          const accepted = await chat.queueMessage({...input,conversationId,expectedDraftRevision:local.baseRevision,modelProfileId:selectedModelId() || undefined});
          if (accepted && chat.conversation()?.id === conversationId) local.baseRevision = chat.conversation()!.draft.revision;
          // Acceptance is durable even if refreshing the visible queue fails.
          void queuedMessages.refresh().catch(() => chat.setError(t().chatActionFailed));
          return accepted;
        } finally {
          local.saving = false;
          touchSession();
        }
      });
    } finally { setComposerSubmitting(false); }
  };
  const changeQueuedMessage = async (message:AssistantQueuedMessage, action:"cancel"|"retry"|"edit") => {
    const conversationId = chat.activeConversationId();
    if (!conversationId || sendingQueuedId()) return;
    setSendingQueuedId(message.id);
    try {
      if (action === "edit") {
        const text = await prompts.prompt(t().editQueued, message.editableText ?? message.text);
        if (!text?.trim()) return;
        await assistantApi.editQueuedMessage(conversationId,message.id,text.trim());
      }
      else if (action === "cancel") await assistantApi.cancelQueuedMessage(conversationId,message.id);
      else await assistantApi.retryQueuedMessage(conversationId,message.id);
      await queuedMessages.refresh();
    } catch (error) { chat.setError(error instanceof Error ? error.message : t().chatActionFailed); }
    finally {setSendingQueuedId(null);}
  };

  const activeConversation = () =>
    conversations().find((conversation) => conversation.id === chat.activeConversationId()) ?? chat.conversation();
  const [todoOpen, setTodoOpen] = createSignal(false);
  const todoItems = () => {
    const checkpoint = chat.conversation()?.todoPlan;
    let todos = checkpoint?.todos ?? [];
    for (const stored of chat.messages()) {
      if (stored.seq <= (checkpoint?.seq ?? -1)) continue;
      const message = stored.message;
      const plan = message.role === "tool_result" && message.name === "todo_write" && !message.isError
        ? parseAiTodoPlan(message.result) : stored.meta?.todoPlan;
      if (plan) todos = plan.todos;
    }
    for (const block of chat.activeTurn()?.blocks ?? []) {
      if (block.kind === "tool" && block.name === "todo_write" && block.status === "completed" && !block.isError) {
        const plan = parseAiTodoPlan(block.result);
        if (plan) todos = plan.todos;
      }
    }
    return todos;
  };
  const hasOpenTodos = createMemo(() => todoItems().some(item => item.status === "pending" || item.status === "in_progress"));
  const [showCompletedTodos, setShowCompletedTodos] = createSignal(false);
  createEffect(() => {
    chat.activeConversationId();
    hasOpenTodos();
    setShowCompletedTodos(false);
    setTodoOpen(false);
  });
  const todoProgress = () => {
    const todos = todoItems(), done = todos.filter(item => item.status === "completed").length;
    const cancelled = todos.filter(item => item.status === "cancelled").length;
    const de = locale().startsWith("de");
    return `${done}/${todos.length - cancelled} ${de ? "erledigt" : "complete"}${cancelled ? ` · ${cancelled} ${de ? "verworfen" : "cancelled"}` : ""}`;
  };
  const activeConversationProject = () => {
    const projectId = activeConversation()?.projectId;
    return projectId ? (projects().find((project) => project.id === projectId) ?? null) : null;
  };
  const emptyChat = () => !chat.loadingConversation() && chat.messages().length === 0 && !chat.activeTurn();
  const [emptyProjectId, setEmptyProjectId] = createSignal<string | null>(activeConversation()?.projectId ?? null);
  const [choosingProject, setChoosingProject] = createSignal(false);
  let emptyProjectConversationId: string | null = null;
  createEffect(() => {
    const conversation = activeConversation();
    if ((conversation?.id ?? null) === emptyProjectConversationId) return;
    emptyProjectConversationId = conversation?.id ?? null;
    setEmptyProjectId(conversation?.projectId ?? null);
  });

  const chooseEmptyChatProject = async () => {
    const selected = await openSpotlightSearch<{ projectId: string | null }>({
      title: t().chooseProjectTitle,
      icon: "ti ti-folder-open",
      placeholder: t().searchProjects,
      minQueryLength: 0,
      noResultsText: t().noMatchingProjects,
      resolve: ({ query }) => {
        const normalized = query.trim().toLocaleLowerCase();
        return [
          {
            value: { projectId: null },
            label: t().noProject,
            desc: t().separateChat,
            icon: "ti ti-message-circle",
          },
          ...projects()
            .filter((project) => !normalized || `${project.name} ${project.description}`.toLocaleLowerCase().includes(normalized))
            .map((project) => ({
              value: { projectId: project.id },
              label: project.name,
              desc: project.description || t().sharedProjectContext,
              icon: project.icon || "ti ti-folder",
            })),
        ];
      },
    });
    if (!selected?.value || selected.value.projectId === emptyProjectId()) return;

    setChoosingProject(true);
    try {
      const conversation = activeConversation();
      if (!conversation) {
        if (selected.value.projectId) await createConversation(true, selected.value.projectId);
        return;
      }
      const updated = await assistantApi.updateConversationProject(conversation.id, selected.value.projectId);
      setEmptyProjectId(updated.projectId);
      await Promise.all([
        chat.refreshActiveConversation(),
        sidebar.invalidate({
          cursor: null,
          domains: new Set(["conversation-list"]),
          conversationIds: new Set([updated.id]),
          projectIds: null,
        }),
      ]);
    } catch (error) {
      chat.setError(error instanceof Error ? error.message : t().chooseProjectFailed);
    } finally {
      setChoosingProject(false);
    }
  };

  const useStarter = async (starter: AssistantStarterAction) => {
    const key=composerSessionKey();
    const current=composerDraft(key);
    setComposerDraft(key,current.trim() ? `${current}\n\n${starter.prompt}` : starter.prompt);
    focusComposer();
    if(starter.skill) try {
      const skill=(await assistantApi.listSkills()).find(skill=>skill.enabled && skill.name===starter.skill);
      if(!skill || composerSessionKey()!==key || composerAttachmentsFor(key).some(item=>item.kind==="resource" && item.ref.type==="core.ai.skill" && item.ref.id===skill.id))return;
      await addResolvedComposerResource(key,{type:"core.ai.skill",id:skill.id});
    } catch { chat.setError(t().attachResourceFailed); }
  };
  const addComposerFiles = async (sessionKey: string, files: readonly File[]) => {
    const current = composerAttachmentsFor(sessionKey);
    const result = await readAiComposerFiles(files, {
      acceptsImages: acceptsImages(),
      currentCount: current.length,
      currentImageBytes: current.reduce((total, attachment) => total + (attachment.kind === "image" ? attachment.size : 0), 0),
    });
    const attachmentErrors = [...result.errors];
    if (result.discarded > 0) {
      attachmentErrors.push(t().discardedAttachments({ count: result.discarded }));
    }
    if (attachmentErrors.length > 0) chat.setError(attachmentErrors.join(" "));
    if (result.attachments.length === 0) return;
    setComposerAttachmentsFor(sessionKey, [...composerAttachmentsFor(sessionKey), ...result.attachments]);
  };

  const composerAttachmentsBlocked = (sessionKey: string) => chat.activeConversationId() === sessionKey && chat.running();

  const requireComposerAttachmentsAvailable = (sessionKey: string) => {
    if (!composerAttachmentsBlocked(sessionKey)) return true;
    chat.setError(t().attachmentsAfterResponse);
    return false;
  };

  const addResolvedComposerResource = async (sessionKey: string, ref: { type: string; id: string }) => {
    if (!requireComposerAttachmentsAvailable(sessionKey)) return;
    const current = composerAttachmentsFor(sessionKey);
    if (current.some((item) => item.kind === "resource" && item.ref.type === ref.type && item.ref.id === ref.id)) {
      chat.setError(t().resourceAlreadyAttached);
      return;
    }
    if (current.length >= AI_TURN_ATTACHMENT_MAX_ITEMS) {
      chat.setError(t().attachmentLimit({ count: AI_TURN_ATTACHMENT_MAX_ITEMS }));
      return;
    }
    const resource = await resolveAssistantCloudResource(ref);
    const latest = composerAttachmentsFor(sessionKey);
    if (latest.some((item) => item.kind === "resource" && item.ref.type === ref.type && item.ref.id === ref.id)) {
      chat.setError(t().resourceAlreadyAttached);
      return;
    }
    if (latest.length >= AI_TURN_ATTACHMENT_MAX_ITEMS) {
      chat.setError(t().attachmentLimit({ count: AI_TURN_ATTACHMENT_MAX_ITEMS }));
      return;
    }
    setComposerAttachmentsFor(sessionKey, [
      ...latest,
      {
        kind: "resource",
        id: `resource:${resource.ref.type}:${resource.ref.id}`,
        name: resource.title,
        ref: resource.ref,
        icon: resource.icon,
        href: resource.href,
      },
    ]);
  };

  const showComposerTextAttachment = async (sessionKey: string, attachment: AiComposerAttachment) => {
    let text: string;
    if (attachment.kind === "file") {
      text = await attachment.file.text();
    } else if (attachment.kind === "stored-file") {
      const conversationId = chat.activeConversationId();
      if (!conversationId) throw new Error(t().openChatBeforeAttachment);
      const query = new URLSearchParams({ path: attachment.path });
      const response = await fetch(`/api/ai/conversations/${encodeURIComponent(conversationId)}/files/content?${query}`);
      if (!response.ok) throw new Error(t().loadTextAttachmentFailed);
      text = await response.text();
    } else {
      return;
    }
    const currentText = composerDraft(sessionKey);
    const nextText = currentText ? `${currentText}\n\n${text}` : text;
    if (nextText.length > AI_COMPOSER_TEXT_MAX_CHARS) throw new Error(t().textTooLong);
    setComposerDraft(sessionKey, nextText);
    setComposerAttachmentsFor(
      sessionKey,
      composerAttachmentsFor(sessionKey).filter((candidate) => candidate.id !== attachment.id),
    );
    focusComposer();
  };

  const pasteComposerContent = (sessionKey: string, event: ClipboardEvent) => {
    const structured = [cloudResourceClipboard.webFormat, cloudResourceClipboard.mimeType]
      .map((type) => event.clipboardData?.getData(type) ?? "")
      .find(Boolean);
    const ref = structured ? cloudResourceClipboard.parse(structured, props.cloudUrl) : null;
    if (ref) {
      event.preventDefault();
      if (!requireComposerAttachmentsAvailable(sessionKey)) return;
      void addResolvedComposerResource(sessionKey, ref).catch((error) =>
        chat.setError(error instanceof Error ? error.message : t().attachResourceFailed),
      );
      return;
    }
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!text || !shouldAttachAiPastedText(text, composerDraft(sessionKey).length)) return;
    event.preventDefault();
    if (!requireComposerAttachmentsAvailable(sessionKey)) return;
    void addComposerFiles(sessionKey, [createAiPastedTextFile(text)]);
  };

  const addComposerResource = async (sessionKey: string) => {
    if (!requireComposerAttachmentsAvailable(sessionKey)) return;
    if (composerAttachmentsFor(sessionKey).length >= AI_TURN_ATTACHMENT_MAX_ITEMS) {
      chat.setError(t().attachmentLimit({ count: AI_TURN_ATTACHMENT_MAX_ITEMS }));
      return;
    }
    const existing = composerAttachmentsFor(sessionKey).filter((item) => item.kind === "resource");
    const selected = await openCloudResourcePicker({
      title: t().attachResource,
      excludeRefs: existing.map((item) => item.ref),
      requireReader: true,
    });
    if (!selected) return;
    setComposerAttachmentsFor(sessionKey, [
      ...composerAttachmentsFor(sessionKey),
      {
        kind: "resource",
        id: `resource:${selected.ref.type}:${selected.ref.id}`,
        name: selected.title,
        ref: selected.ref,
        icon: selected.icon ?? selected.appIcon ?? "ti ti-cloud",
        href: selected.href,
      },
    ]);
  };

  const dictationKey = () => (activeProject() ? projectComposerKey(activeProject()!.id) : composerSessionKey());
  const dictationTarget = () => (activeProject() ? (pendingProjectChats()[activeProject()!.id]?.id ?? null) : chat.activeConversationId());
  const dictation = createAssistantDictation({
    configured: () => Boolean(props.status.audioModelConfigured) && canUseComposer(),
    key: dictationKey,
    target: dictationTarget,
    generation: (key) => {
      composerDraft(key);
      composerAttachmentsFor(key);
      return session(key).editGeneration;
    },
    live: liveHub,
    ensureTarget: async () => {
      const key = dictationKey();
      const projectId = activeProject()?.id;
      const target = dictationTarget();
      if (target) return { key, target };
      const created = await createConversation(false, projectId, !projectId);
      if (!created) return null;
      if (projectId) {
        session(key).baseRevision = created.draft.revision;
        setPendingProjectChats((all) => ({ ...all, [projectId]: created }));
        return { key, target: created.id };
      }
      setComposerDraft(created.id, composerDraft(key));
      setComposerAttachmentsFor(created.id, composerAttachmentsFor(key));
      session(created.id).baseRevision = created.draft.revision;
      return { key: created.id, target: created.id };
    },
    apply: async (key, target, id) => {
      const generation = session(key).editGeneration;
      const saved = await saveComposer(key, target);
      if (!saved || generation !== session(key).editGeneration) return false;
      return serializeComposer(key, async () => {
        const local = session(key);
        if (local.conflict || local.editGeneration !== generation) return false;
        local.saving = true;
        try {
          const response = await fetch(`/api/ai/conversations/${target}/dictations/${id}/apply`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedRevision: local.baseRevision, content: saved.content }),
          });
          if (!response.ok) {
            local.conflict = true;
            await chat.refreshActiveConversation();
            return false;
          }
          const result: { disposition: string; draft: AiConversation["draft"] | null } = await response.json();
          if (result.draft) {
            setServerDrafts((all) => ({ ...all, [key]: result.draft! }));
            if (local.editGeneration === generation) hydrateComposer(key, result.draft);
            else local.conflict = true;
          } else if (result.disposition === "applied") {
            local.conflict = true;
          }
          await chat.refreshActiveConversation();
          return result.disposition === "applied";
        } finally {
          local.saving = false;
          touchSession();
        }
      });
    },
  });

  const AssistantComposer = (composerProps: { projectId?: string; projectName?: string }) => {
    const sessionKey = () => (composerProps.projectId ? projectComposerKey(composerProps.projectId) : composerSessionKey());
    const projectComposer = () => Boolean(composerProps.projectId);
    return (
      <>
        <Show when={!projectComposer() ? chat.activeConversationId() : null}>
          {(conversationId) => (
            <AssistantQueuedMessages
              messages={queuedMessagesFor(conversationId())}
              sendingId={sendingQueuedId()}
              onRetry={(message) => void changeQueuedMessage(message, "retry")}
              onDelete={(message) => void changeQueuedMessage(message, "cancel")}
              onEdit={(message) => void changeQueuedMessage(message, "edit")}
            />
          )}
        </Show>
        <dictation.Status />
        <Show when={(sessionVersion(), session(sessionKey()).conflict)}>
          <div role="status" class="space-y-2 rounded-lg border border-border p-3 text-sm">
            <p>{audioCopy().conflict}</p>
            <Show when={serverDrafts()[sessionKey()]}>
              {(saved) => (
                <>
                  <p>{audioCopy().savedDraft}</p>
                  <pre class="max-h-48 overflow-auto whitespace-pre-wrap">
                    {saved()
                      .content.filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("\n\n")}
                  </pre>
                  <Button size="sm" variant="secondary" onClick={() => hydrateComposer(sessionKey(), saved())}>
                    {audioCopy().useSaved}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const key = sessionKey();
                      const target = dictationTarget();
                      if (!target) return;
                      const local = session(key);
                      local.baseRevision = saved().revision;
                      local.conflict = false;
                      await saveComposer(key, target);
                    }}
                  >
                    {audioCopy().keepLocal}
                  </Button>
                </>
              )}
            </Show>
          </div>
        </Show>
        <Chat.Composer
          accessory={<Show when={!projectComposer() && (hasOpenTodos() || showCompletedTodos())}>
          <Chat.Tasks items={todoItems()} open={todoOpen()} onOpenChange={setTodoOpen}
            label={locale().startsWith("de") ? "Aufgaben" : "Tasks"} progressLabel={todoProgress()}
            statusLabels={locale().startsWith("de")
              ? { pending: "Offen", in_progress: chat.activeTurn()?.status === "running" ? "In Arbeit" : "Aktueller Schritt", completed: "Erledigt", cancelled: "Verworfen" }
              : { pending: "Pending", in_progress: chat.activeTurn()?.status === "running" ? "In progress" : "Current step", completed: "Completed", cancelled: "Cancelled" }} />
        </Show>}
          draftKey={sessionKey()}
          mentions={mentionsFor(sessionKey())}
          onMentionsChange={mentions => setMentionsFor(sessionKey(), mentions)}
          commands={[
            { name: "compact", description: locale().startsWith("de") ? "Chat-Kontext kompaktieren" : "Compact chat context", icon: "ti ti-fold",
              disabled: projectComposer() || chat.running() || !chat.messages().length,
              action: async () => { if (!await chat.compactConversation({ modelProfileId: selectedModelId() || undefined })) throw new Error(t().chatActionFailed); } },
            { name: "fork", description: locale().startsWith("de") ? "Chat ab der letzten Antwort abzweigen" : "Fork at the latest response", icon: "ti ti-git-fork",
              disabled: projectComposer() || chat.running() || !chat.messages().some(message => message.message.role === "assistant"),
              action: async () => {
                const target = [...chat.messages()].reverse().find(message => message.message.role === "assistant");
                if (!target) return;
                const key = sessionKey();
                const saved = await saveComposer(key, key);
                if (!saved) throw new Error(t().chatActionFailed);
                if (sessionKey() !== key) return;
                const fork = await chat.forkMessage(target.id, {});
                if (!fork) throw new Error(t().chatActionFailed);
                hydrateComposer(fork.id, { ...fork.draft, content: saved.content });
                editComposerSession(session(fork.id));
                if (!await saveComposer(fork.id, fork.id)) throw new Error(t().chatActionFailed);
                if (chat.activeConversationId() === fork.id) focusComposer();
              } },
            { name: "new", description: locale().startsWith("de") ? "Neuen Chat öffnen" : "Open a new chat", icon: "ti ti-plus",
              action: async () => {
                const key = sessionKey();
                if (chat.activeConversationId() && !projectComposer() && !await saveComposer(key, key)) throw new Error(t().chatActionFailed);
                if (sessionKey() !== key) return;
                await createAndFocusConversation();
              } },
          ]}
          searchCommands={(query, signal) => assistantComposerCommands({ query, signal, locale: locale(),
            conversationId: projectComposer() ? undefined : chat.activeConversationId() ?? undefined,
            projectId: composerProps.projectId ?? chat.conversation()?.projectId, projects: projects(), running: chat.running(),
            assignProject: async projectId => {
              const key = sessionKey();
              const text = composerDraft(key), attachments = composerAttachmentsFor(key), mentions = mentionsFor(key);
              const existing = chat.activeConversationId();
              const created = existing ? null : await createConversation(false);
              const conversationId = existing ?? created?.id;
              if (!conversationId) throw new Error(t().chatActionFailed);
              if (created) {
                setComposerDraft(conversationId, text);
                setComposerAttachmentsFor(conversationId, attachments);
                setMentionsFor(conversationId, mentions);
                session(conversationId).baseRevision = created.draft.revision;
              }
              if (!await saveComposer(conversationId, conversationId)) throw new Error(t().chatActionFailed);
              if (chat.activeConversationId() !== conversationId) return;
              const updated = await assistantApi.assignProject(conversationId, projectId);
              if (chat.activeConversationId() === conversationId) setEmptyProjectId(updated.projectId);
              await Promise.all([
                chat.refreshActiveConversation(),
                sidebar.invalidate({ cursor: null, domains: new Set(["conversation-list"]), conversationIds: new Set([updated.id]), projectIds: null }),
              ]);
            },
          })}
          submitTools={<dictation.Control />}
          footerContent={dictation.recording() ? <dictation.RecordingFooter /> : undefined}
          value={composerDraft(sessionKey())}
          onValueChange={(value) => setComposerDraft(sessionKey(), value)}
          attachments={aiChatAttachments(composerAttachmentsFor(sessionKey()), {
            onShowText: (attachment) => showComposerTextAttachment(sessionKey(), attachment),
          })}
          onAttachmentsChange={(next) => setComposerAttachmentsFor(sessionKey(), aiComposerAttachmentRecords(next))}
          onPaste={(event) => pasteComposerContent(sessionKey(), event)}
          fileSelection={{
            onSelect: (files) => addComposerFiles(sessionKey(), files),
            accept: aiComposerFileAccept,
            disabled: !projectComposer() && chat.running(),
            label: t().attachFiles,
          }}
          models={aiChatModelOptions(props.models)}
          selectedModelId={selectedModelId()}
          onModelChange={setSelectedModelId}
          modelDetails={
            <AssistantQuota
              snapshot={quotas.data()}
              model={selectedModelId()}
              modelLabel={props.models.find((m) => m.id === selectedModelId())?.label ?? selectedModelId()}
              error={quotas.error()}
              loading={quotas.loading() || quotas.refreshing()}
              onRefresh={quotas.refresh}
            />
          }
          disabled={!canUseComposer() || newConversation.loading() || chat.loadingConversation()}
          state={
            projectComposer()
              ? newConversation.loading()
                ? "submitting"
                : "idle"
              : chat.runStatus() === "stopping"
                ? "stopping"
                : chat.running()
                  ? "running"
                  : "idle"
          }
          focusToken={projectComposer() ? undefined : composerFocusToken()}
          runningSubmitIntent={!projectComposer() ? "queue" : undefined}
          placeholder={
            props.status.enabled && props.models.length === 0
              ? t().noModelsAvailable
              : props.status.enabled
                ? projectComposer()
                  ? t().startProjectChat({ project: composerProps.projectName ?? t().thisProject })
                  : chat.runStatus() === "stopping"
                    ? t().stopping
                    : chat.running()
                      ? t().queueMessage
                      : t().askAnything
                : t().aiNotConfigured
          }
          error={projectComposer() ? (chat.error() ?? undefined) : undefined}
          onSubmit={(input) =>
            composerProps.projectId
              ? sendProjectMessage(composerProps.projectId, aiComposerSendInput(input))
              : (input.intent === "queue" || (input.intent === "send" && Boolean(queuedMessages.data()?.length)))
                ? queueMessage(aiComposerSendInput(input))
                : input.intent === "steer"
                  ? steer(input.text)
                  : send(aiComposerSendInput(input))
          }
          onStop={
            !projectComposer() && chat.activeTurn()
              ? async () => {
                  await chat.abort();
                }
              : undefined
          }
          onError={(error) => chat.setError(error instanceof Error ? error.message : t().chatActionFailed)}
          menuActions={[
            {
              id: "attach-resource",
              label: t().attachResource,
              icon: "ti ti-cloud-plus",
              disabled: composerAttachmentsBlocked(sessionKey()),
              onSelect: () => addComposerResource(sessionKey()),
            },
            ...(!projectComposer() && activeConversation()
              ? [
                  {
                    id: "search-chat",
                    label: t().searchThisChat,
                    icon: "ti ti-search",
                    onSelect: async () => {
                      const conversation = activeConversation();
                      if (!conversation) return;
                      openGlobalSearch(assistantSearchOptions(locale(), conversation));
                    },
                  },
                ]
              : []),
          ]}
          contextActions={!projectComposer() && todoItems().length > 0 && !hasOpenTodos() ? [{
            id: "toggle-completed-tasks",
            icon: "ti ti-list-check",
            label: locale().startsWith("de")
              ? showCompletedTodos() ? "Aufgaben ausblenden" : "Aufgaben anzeigen"
              : showCompletedTodos() ? "Hide tasks" : "Show tasks",
            pressed: showCompletedTodos(),
            onSelect: () => {
              const visible = !showCompletedTodos();
              setShowCompletedTodos(visible);
              setTodoOpen(visible);
            },
          }] : []}
          contextPopupAction={
            !projectComposer() && activeConversation()
              ? {
                  id: "compact-context",
                  label: t().compactContext,
                  icon: "ti ti-package",
                  disabled: chat.running(),
                  onSelect: async () => {
                    if (!chat.activeConversationId()) return;
                    await chat.compactConversation({ modelProfileId: selectedModelId() || undefined });
                  },
                }
              : undefined
          }
          contextUsage={
            projectComposer()
              ? undefined
              : {
                  usage: usageSnapshot()?.request ?? null,
                  loopUsage: usageSnapshot()?.loop ?? null,
                  contextWindow: usageModel()?.contextWindow,
                  modelLabel: usageModel()?.label,
                }
          }
        />
      </>
    );
  };

  const updateConversation = (updated: AiConversation) => {
    void sidebar.invalidate({
      cursor: null,
      domains: new Set(["conversation-list"]),
      conversationIds: new Set([updated.id]),
      projectIds: null,
    });
  };

  createEffect(() => {
    const conversation = activeConversation();
    if (!conversation || activeProject()) return;
    const copy = assistantCommandMessages.resolve([locale()]).t;
    onCleanup(registerContextAwareCommand({ id: `assistant.${conversation.id}.search`, title: t().searchThisChat,
      description: copy.searchChatDescription({ title: conversation.title }), icon: "ti ti-search",
      scope: "selection", shortcut: "mod+shift+k",
      action: { search: assistantSearchOptions(locale(), conversation) },
    }));
    if (!["queued", "running", "needs_attention", "waiting_for_browser"].includes(conversation.runStatus))
      onCleanup(registerContextAwareCommand({ id: `assistant.${conversation.id}.done`, title: conversation.isDone ? copy.reopen : copy.done,
        description: conversation.isDone ? copy.reopenDescription({ title: conversation.title }) : copy.doneDescription({ title: conversation.title }),
        scope: "selection", shortcut: "d", icon: "ti ti-check", action: async () => updateConversation(await assistantApi.setConversationDone(conversation.id, !conversation.isDone)),
      }));
  });

  const archiveConversation = (archived: AiConversation) => {
    void sidebar.invalidate({
      cursor: null,
      domains: new Set(["conversation-list"]),
      conversationIds: new Set([archived.id]),
      projectIds: null,
    });
    setComposerDrafts((current) => {
      const next = { ...current };
      delete next[archived.id];
      return next;
    });
    setComposerAttachments((current) => {
      const next = { ...current };
      delete next[archived.id];
      return next;
    });
    setModelChoices((current) => {
      const next = { ...current };
      delete next[archived.id];
      return next;
    });
    if (archived.id === chat.activeConversationId()) navigateTo("/app/assistant");
  };

  const composerNotice = createMemo(() =>
    chat.streamStatus() === "reconnecting"
      ? { message: t().reconnecting, reconnecting: true }
      : chat.error() || liveError()
        ? { message: chat.error() ?? liveError()!, reconnecting: false }
        : null,
  );
  const ComposerNotices = () => (
    <Show when={composerNotice()}>
      {(notice) => (
        <p
          class={`inline-flex w-full items-start gap-1.5 px-1 text-xs ${notice().reconnecting ? "text-[var(--k2b-warning-text)]" : "text-[var(--k2b-danger-text)]"}`}
          role={notice().reconnecting ? "status" : "alert"}
        >
          <i
            class={`${notice().reconnecting ? "ti ti-refresh animate-spin motion-reduce:animate-none" : "ti ti-alert-circle"} mt-0.5 text-sm`}
            style={notice().reconnecting ? { "animation-direction": "reverse" } : undefined}
            aria-hidden="true"
          />
          <span>{notice().message}</span>
        </p>
      )}
    </Show>
  );

  const ConversationTimeline = () => {
    const items = createAiChatTimeline({ messages: chat.messages, activeTurn: chat.activeTurn });

    return (
      <Chat.Timeline
        class="ai-message-list-container h-full"
        conversationKey={chat.activeConversationId()}
        items={items()}
        loading={chat.loadingConversation()}
        hasMore={chat.hasMoreHistory()}
        loadingOlder={chat.loadingOlder()}
        onLoadOlder={chat.loadOlderMessages}
        emptyTitle={props.status.enabled ? t().startConversation : t().aiDisabled}
        viewportRef={setTimelineViewport}
        contentRef={setTimelineContent}
        scrollToAnchorRef={(scrollToAnchor) => { scrollToMessageAnchor = scrollToAnchor; }}
        onActionError={(error) => chat.setError(error instanceof Error ? error.message : t().chatActionFailed)}
        navigation={
          <AiChatTurnNavigator
            entries={chat.timeline()}
            loading={chat.timelineLoading()}
            viewport={timelineViewport}
            content={timelineContent}
            loadThrough={chat.loadHistoryThroughSeq}
          />
        }
      />
    );
  };

  return (
    <AssistantLiveProvider value={liveHub}>
      <AppWorkspace mobileSurface="flush" class="flex-1 min-h-0">
        <AssistantSidebar
          conversations={conversations}
          doneCount={sidebar.data()?.doneCount ?? props.initialDoneCount}
          activeConversationId={chat.activeConversationId}
          activeView="chat"
          projects={projects()}
          activeProjectId={activeProject()?.id ?? null}
          creatingConversation={newConversation.loading}
          onNewConversation={() => void createAndFocusConversation()}
          onCreateProject={async () => {
            const project = await openAssistantCreateProjectDialog();
            if (project) navigateTo(assistantProjectHref("/app/assistant", project.id));
          }}
          onOpenProject={openProject}
          onOpenConversation={openAndFocusConversation}
          canArchiveConversation={(conversation) => conversation.id !== chat.activeConversationId() || !chat.activeTurn()}
          onConversationUpdated={updateConversation}
          onConversationArchived={archiveConversation}
          live={liveHub}
        />

        <AppWorkspace.Content>
          <AppWorkspace.Main scroll={false} mobilePane={artifactWorkspace.mobile()}>
            <AppWorkspace.MainPane id="chat" label={artifactCopy().chat} scroll={false} class="assistant-chat-pane flex min-h-0 flex-col">
            <Show
              keyed
              when={projectView()}
              fallback={
                <Chat class="assistant-chat-shell min-h-0 flex-1">
                  <Show when={activeConversation()}>
                    <div class="assistant-context-open">
                      <Dropdown.Root items={contextMenuItems()}>
                        <Dropdown.Trigger iconOnly label={artifactCopy().open}><i class="ti ti-plus" aria-hidden="true" /></Dropdown.Trigger>
                      </Dropdown.Root>
                    </div>
                  </Show>
                  <div class="assistant-chat-layout">
                    <div class="contents">
                      <section class="assistant-chat-messages min-h-0 overflow-hidden" data-scroll-preserve="assistant-messages">
                        <Show
                          when={emptyChat()}
                          fallback={
                            <AiChatActionsProvider
                              actions={{
                                renderCodePresentation: result => <ChatPresentation result={result} conversationId={chat.activeConversationId()!} httpHost={browserHttpHost} />,
                                actionDisabled: () => chat.runStatus() === "stopping",
                                onApproval: async (request, input) => {
                                  if (!(await chat.respondToApproval(request, input))) throw new Error(t().submitApprovalFailed);
                                },
                                onFrontendToolResult: async (request, result) => {
                                  if (!(await chat.submitFrontendToolResult(request, result))) throw new Error(t().submitToolFailed);
                                },
                                onForkMessage: async (entry, input) => {
                                  const conversation = await chat.forkMessage(entry.id, input);
                                  if (!conversation) throw new Error(t().forkFailed);
                                  if (chat.activeConversationId() === conversation.id) commitConversationUrl(conversation.id);
                                },
                                onRetryMessage: async (entry, input) => {
                                  const retried = await chat.retryUserMessage(entry.id, {
                                    ...input,
                                    modelProfileId: selectedModelId() || undefined,
                                  });
                                  if (!retried) throw new Error(chat.error() ?? t().retryMessageFailed);
                                },
                                onMessageFeedback: async (entry, feedback) => {
                                  const saved = feedback
                                    ? await chat.setMessageFeedback(entry.id, feedback)
                                    : await chat.clearMessageFeedback(entry.id);
                                  if (!saved) throw new Error(chat.error() ?? t().saveFeedbackFailed);
                                },
                                onRetrySteer: async (block) => {
                                  if (!(await chat.retrySteer(block))) throw new Error(chat.error() ?? t().retrySteerFailed);
                                },
                                onOpenScheduledTaskRun: (taskId, occurrenceId) => void openAssistantTaskRun(taskId, occurrenceId, liveHub),
                                onOpenFile: (path) => void openFiles(path),
                                resolveFileLink: href => {
                                  const context = workspaceContext() ?? props.initialContext;
                                  const conversationId = chat.activeConversationId();
                                  return conversationId && context?.chatId === conversationId
                                    ? resolveChatFileLink(href, window.location.href, conversationId, context.files.map(file => file.path))
                                    : null;
                                },
                                fileUrl: chat.fileContentUrl,
                              }}
                            >
                              <ConversationTimeline />
                            </AiChatActionsProvider>
                          }
                        >
                          <AssistantEmptyChat
                            composer={<AssistantComposer />}
                            notices={<ComposerNotices />}
                            projects={projects()}
                            selectedProjectId={emptyProjectId()}
                            choosingProject={choosingProject()}
                            onChooseProject={() => void chooseEmptyChatProject()}
                            onStarter={useStarter}
                          />
                        </Show>
                        <codeApprovals.View conversationTitle={id=>conversations().find(c=>c.id===id || c.shortId===id)?.title}/>
                      </section>

                      <Show when={!emptyChat()}>
                        <div class="assistant-chat-composer shrink-0 px-[var(--ui-space-section)] pb-[var(--ui-space-section)] pt-2">
                          <div class="mx-auto flex max-w-3xl flex-col gap-2">
                            <ComposerNotices />
                            <AssistantComposer />

                          </div>
                        </div>
                      </Show>
                    </div>
                    <Show when={activeConversation()}>
                      {(conversation) => (
                        <div class="contents">
                          <AssistantChatContextPanel
                            onOpenView={openContextView}
                            onSnapshotChange={setWorkspaceContext}
                            onOpenApp={(id, title, start) => artifactWorkspace.open(appTab(id, title, start))}
                            chatId={conversation().id}
                            project={activeConversationProject()}
                            initial={props.initialContext?.chatId === conversation().id ? props.initialContext : null}
                          />
                        </div>
                      )}
                    </Show>
                  </div>
                </Chat>
              }
            >
              {(view) => (
                <Show when={projects().find((project) => project.id === view.projectId)}>
                  {(project) => (
                    <AssistantProjectView
                      project={project()}
                      initialPage={view.page}
                      initialContext={view.context}
                      composer={<AssistantComposer projectId={project().id} projectName={project().name} />}
                      onOpenConversation={openAndFocusConversation}
                    />
                  )}
                </Show>
              )}
            </Show>
            </AppWorkspace.MainPane>
            <AppWorkspace.MainPane id="workspace" label={artifactCopy().workspace} open={artifactWorkspace.state().tabs.length > 0} defaultSize={620} minSize={320} scroll={false}>
              <ArtifactWorkspace onOpenView={openContextView} project={activeConversationProject()} conversationId={chat.activeConversationId()} controller={artifactWorkspace} userId={props.userId} refreshKey={filesRefreshKey()} menuItems={contextMenuItems()} />
            </AppWorkspace.MainPane>
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </AssistantLiveProvider>
  );
}
