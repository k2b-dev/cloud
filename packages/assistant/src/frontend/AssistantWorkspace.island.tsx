import { navigate, navigateTo } from "@k2b/ssr/nav";
import { mutation, query } from "@k2b/stdlib/solid";
import { AppWorkspace, Button, Chat, openSpotlightSearch, prompts, useLocale } from "@k2b/ui";
import type {
  AiConversation,
  AiConversationPage,
  AiConversationTimelineEntry,
  AiProject,
  AiPublicModelProfile,
  AiSettingsError,
  AiStoredMessage,
} from "@valentinkolb/cloud/ai";
import { type AiLiveConnection, createAiChatController, createAiLiveConnection } from "@valentinkolb/cloud/ai/solid";
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
  aiLatestUsageSnapshot,
  createAiChatTimeline,
  createAiPastedTextFile,
  readAiComposerFiles,
  shouldAttachAiPastedText,
} from "@valentinkolb/cloud/ai/ui";
import { cloudResourceClipboard } from "@valentinkolb/cloud/browser/resource-clipboard";
import { openCloudResourcePicker } from "@valentinkolb/cloud/browser/resource-picker";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { assistantApi } from "../api/client";
import type { AssistantChatContextSnapshot } from "../chat-context";
import type { AssistantProjectContextSnapshot } from "../project-context";
import type { AssistantSidebarSnapshot } from "../sidebar";
import { openAssistantFilesDialog } from "./AssistantArtifactDetail";
import { AssistantChatContextPanel, assistantChatContextHasPanel, openAssistantChatContextDialog } from "./AssistantChatContext";
import { assistantMessageAnchorSeq, openAssistantChatMessageSearch } from "./AssistantChatMessageSearch";
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
  assistantArtifactHref,
  assistantArtifactPathFromHref,
  assistantConversationHref,
  assistantConversationIdFromHref,
  assistantProjectHref,
  assistantProjectIdFromHref,
} from "./assistant-navigation";
import { submitAssistantProjectMessage } from "./assistant-project-chat";
import { assistantMessages } from "./messages";

type Status = {
  ok: boolean;
  enabled: boolean;
  defaultModelId: string;
  visionModelConfigured: boolean;
  error: AiSettingsError | null;
  models: AiPublicModelProfile[];
};

type InitialDetail = {
  conversation: AiConversation;
  messages: AiStoredMessage[];
  hasMoreMessages?: boolean;
  activeTurn: import("@valentinkolb/cloud/ai").AiTurnSnapshot | null;
  timeline?: AiConversationTimelineEntry[];
};

type Props = {
  cloudUrl: string;
  status: Status;
  models: AiPublicModelProfile[];
  /** Model of the user's most recent turn (any chat) — preselected for new chats. */
  lastModelId: string;
  initialLiveCursor: string;
  initialConversations: AiConversation[];
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
  const t = () => assistantMessages.resolve([locale()]).t;
  const isSelectable = (modelId: string | null | undefined): modelId is string =>
    Boolean(modelId && props.models.some((model) => model.id === modelId));

  const [liveError, setLiveError] = createSignal<string | null>(null);
  let liveConnection: AiLiveConnection | null = null;
  const liveHub = createAssistantLiveInvalidationHub({
    onApplied: (cursor) => {
      setLiveError(null);
      liveConnection?.markApplied(cursor);
    },
    onFailed: () => setLiveError(t().liveRetry),
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

  const chat = createAiChatController({
    baseUrl: "/api/ai",
    initialConversationId: props.initialConversationId,
    initialDetail: props.initialDetail,
    initialTimeline: props.initialDetail?.timeline,
    initialError: props.status.error?.message ?? null,
    trackViewedState: true,
    streamTransport: liveConnection.streamTransport,
  });

  const sidebar = query.create<string, AssistantSidebarSnapshot, AssistantLiveInvalidation>({
    source: () => "/api/assistant/workspace/sidebar",
    initial: {
      source: "/api/assistant/workspace/sidebar",
      data: { conversations: props.initialConversations, projects: props.projects },
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
    invalidate: () => chat.refreshActiveConversation(),
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
  const [queuedMessages, setQueuedMessages] = createSignal<Record<string, AssistantQueuedMessage[]>>({});
  const [sendingQueuedId, setSendingQueuedId] = createSignal<string | null>(null);
  const [composerSubmitting, setComposerSubmitting] = createSignal(false);
  const submittedDrafts = new Set<string>();
  let queuedMessageSequence = 0;
  const [pendingProjectChats, setPendingProjectChats] = createSignal<Record<string, AiConversation>>({});
  const [filesDialogOpen, setFilesDialogOpen] = createSignal(false);
  const [chatContextPresence, setChatContextPresence] = createSignal<boolean | null>(
    props.initialContext
      ? assistantChatContextHasPanel(props.initialContext, Boolean(props.initialDetail?.conversation.projectId))
      : props.initialDetail?.conversation.projectId
        ? true
        : null,
  );
  const [timelineViewport, setTimelineViewport] = createSignal<HTMLDivElement>();
  const [timelineContent, setTimelineContent] = createSignal<HTMLDivElement>();

  const revealMessage = async (message: AiStoredMessage) => {
    const seq = assistantMessageAnchorSeq(message, chat.timeline());
    if (!(await chat.loadHistoryThroughSeq(seq))) {
      chat.setError("Could not load this message.");
      return;
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const viewport = timelineViewport();
    const anchor = timelineContent()?.querySelector<HTMLElement>(`[data-chat-anchor="${seq}"]`);
    if (!viewport || !anchor) {
      chat.setError("Could not find this message in the timeline.");
      return;
    }
    const viewportRect = viewport.getBoundingClientRect();
    viewport.scrollTop = Math.max(0, viewport.scrollTop + anchor.getBoundingClientRect().top - viewportRect.top - 16);
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
  };

  createEffect(() => {
    const conversationId = chat.activeConversationId();
    const conversation = conversations().find((item) => item.id === conversationId) ?? chat.conversation();
    const hasProject = Boolean(conversation?.projectId);
    setChatContextPresence(
      props.initialContext?.chatId === conversationId
        ? assistantChatContextHasPanel(props.initialContext, hasProject)
        : hasProject
          ? true
          : null,
    );
  });

  const canUseComposer = createMemo(() => props.status.ok && props.status.enabled && props.models.length > 0);
  const usageSnapshot = createMemo(() => aiLatestUsageSnapshot(chat.messages()));
  const usageModel = createMemo(() => {
    const snapshot = usageSnapshot();
    const modelId = snapshot ? snapshot.modelProfileId : selectedModelId();
    return props.models.find((model) => model.id === modelId) ?? null;
  });
  const composerSessionKey = () => chat.activeConversationId() ?? (activeProject() ? projectComposerKey(activeProject()!.id) : "__new__");
  const composerDraft = (key: string) => composerDrafts()[key] ?? "";
  const setComposerDraft = (key: string, value: string) => setComposerDrafts((current) => ({ ...current, [key]: value }));
  const composerAttachmentsFor = (key: string) => composerAttachments()[key] ?? [];
  const setComposerAttachmentsFor = (key: string, attachments: AiComposerAttachment[]) =>
    setComposerAttachments((current) => ({ ...current, [key]: attachments }));

  const hydratedDrafts = new Set<string>();
  createEffect(() => {
    const conversation = chat.conversation();
    if (!conversation || hydratedDrafts.has(conversation.id)) return;
    hydratedDrafts.add(conversation.id);
    const text = conversation.draft.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n");
    setComposerDraft(conversation.id, text);
    setComposerAttachmentsFor(
      conversation.id,
      conversation.draft.content.flatMap((part): AiComposerAttachment[] => {
        if (part.type === "resource") {
          return [
            {
              kind: "resource",
              id: `resource:${part.ref.type}:${part.ref.id}`,
              name: part.title ?? part.ref.id,
              ref: part.ref,
              icon: part.icon ?? "ti ti-cloud",
              href: part.href,
            },
          ];
        }
        if (part.type === "file") {
          return [
            {
              kind: "stored-file",
              id: `file:${part.path}:${part.version}`,
              name: part.path.split("/").at(-1) || part.path,
              path: part.path,
              mediaType: part.mediaType,
              size: part.size,
              version: part.version,
              icon: "ti-file",
            },
          ];
        }
        return [];
      }),
    );
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
    if (activeProject()) return;
    if (composerSubmitting()) return;
    const sessionKey = composerSessionKey();
    const text = composerDraft(sessionKey);
    const composerFiles = composerAttachmentsFor(sessionKey);
    const attachments = aiChatAttachments(composerFiles);
    const input = aiComposerSendInput({ intent: "send", text, attachments });
    const hasDraft = Boolean(input.message || input.files?.length || input.resources?.length || input.storedFiles?.length);
    const activeConversationId = chat.activeConversationId();
    if (!hasDraft && activeConversationId && submittedDrafts.delete(activeConversationId)) return;
    if (!chat.activeConversationId() && !hasDraft) return;
    const timer = window.setTimeout(async () => {
      let conversationId = chat.activeConversationId();
      if (!conversationId) {
        const conversation = await createConversation(false);
        if (!conversation) return;
        conversationId = conversation.id;
        hydratedDrafts.add(conversationId);
        setComposerDraft(conversationId, text);
        setComposerAttachmentsFor(conversationId, composerFiles);
      }
      await chat.saveDraft(input);
    }, 2_000);
    onCleanup(() => window.clearTimeout(timer));
  });
  const createAndFocusConversation = () => createConversation(true);
  const canSend = createMemo(
    () => canUseComposer() && !newConversation.loading() && !chat.loadingConversation() && !chat.running() && !chat.activeTurn(),
  );
  let navigationRequest = 0;
  const openAndFocusConversation = async (conversationId: string) => {
    const requestId = ++navigationRequest;
    const result = await chat.openConversation(conversationId);
    if (result === "failed") throw new Error(t().openConversationFailed);
    if (result === "stale" || requestId !== navigationRequest) return false;
    setProjectView(null);
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
    if (!conversationId || filesDialogOpen()) return;
    setFilesDialogOpen(true);
    try {
      await openAssistantFilesDialog({ conversationId, initialPath, refreshKey: filesRefreshKey, live: liveHub });
    } finally {
      setFilesDialogOpen(false);
      const href = assistantArtifactHref(window.location.href, null);
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (href !== current) navigate(href, { replace: true, scroll: "manual", viewTransition: false });
      focusComposer();
    }
  };

  onMount(() => {
    const initialConversationId = chat.activeConversationId();
    if (initialConversationId) commitConversationUrl(initialConversationId, true);
    if (props.initialArtifactPath) requestAnimationFrame(() => void openFiles(props.initialArtifactPath!));

    const handlePopState = () => {
      const conversationId = assistantConversationIdFromHref(window.location.href);
      const projectId = assistantProjectIdFromHref(window.location.href);
      const artifactPath = assistantArtifactPathFromHref(window.location.href);
      if (projectId) {
        void openProject(projectId).catch(() => navigateTo("/app/assistant"));
        return;
      }
      if (!conversationId) {
        navigateTo(`${window.location.pathname}${window.location.search}${window.location.hash}`);
        return;
      }
      if (conversationId !== chat.activeConversationId()) {
        void chat.openConversation(conversationId).then(() => {
          if (artifactPath && chat.activeConversationId() === conversationId) void openFiles(artifactPath);
        });
        return;
      }
      if (artifactPath) void openFiles(artifactPath);
    };
    window.addEventListener("popstate", handlePopState);
    onCleanup(() => window.removeEventListener("popstate", handlePopState));
  });

  const send = async (input: AiComposerSendInput) => {
    if (!canSend()) return false;
    setComposerSubmitting(true);
    try {
      if (!chat.activeConversationId()) {
        const conversation = await createConversation(false);
        if (!conversation || chat.activeConversationId() !== conversation.id) return false;
      }
      const sent = await chat.send({
        ...input,
        modelProfileId: selectedModelId() || undefined,
      });
      if (sent && chat.activeConversationId()) submittedDrafts.add(chat.activeConversationId()!);
      return sent;
    } finally {
      setComposerSubmitting(false);
    }
  };
  const sendProjectMessage = async (projectId: string, input: AiComposerSendInput) => {
    if (!canSend()) return false;
    const modelProfileId = selectedModelId() || undefined;
    return submitAssistantProjectMessage({
      projectId,
      message: input,
      modelProfileId,
      pendingConversation: pendingProjectChats()[projectId],
      activeConversationId: chat.activeConversationId,
      openConversation: chat.openConversation,
      createConversation: (targetProjectId) => createConversation(false, targetProjectId, false),
      send: chat.send,
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

  const queuedMessagesFor = (conversationId: string) => queuedMessages()[conversationId] ?? [];
  const setQueuedMessagesFor = (conversationId: string, update: (messages: AssistantQueuedMessage[]) => AssistantQueuedMessage[]) =>
    setQueuedMessages((current) => ({
      ...current,
      [conversationId]: update(current[conversationId] ?? []),
    }));
  const removeQueuedMessage = (conversationId: string, messageId: string) =>
    setQueuedMessagesFor(conversationId, (messages) => messages.filter((message) => message.id !== messageId));
  const queueMessage = (text: string) => {
    const conversationId = chat.activeConversationId();
    const message = text.trim();
    if (!conversationId || !chat.activeTurn() || !message) return false;
    setQueuedMessagesFor(conversationId, (messages) => [
      ...messages,
      { id: `queued-${Date.now()}-${++queuedMessageSequence}`, text: message },
    ]);
    return true;
  };
  const sendQueuedMessage = async (message: AssistantQueuedMessage) => {
    const conversationId = chat.activeConversationId();
    if (
      !conversationId ||
      chat.runStatus() === "stopping" ||
      sendingQueuedId() ||
      !queuedMessagesFor(conversationId).some((item) => item.id === message.id)
    ) {
      return;
    }
    setSendingQueuedId(message.id);
    try {
      const sent = chat.activeTurn() ? await steer(message.text) : await send({ message: message.text });
      if (sent) {
        removeQueuedMessage(conversationId, message.id);
      } else {
        setQueuedMessagesFor(conversationId, (messages) =>
          messages.map((item) => (item.id === message.id ? { ...item, failed: true } : item)),
        );
      }
    } finally {
      setSendingQueuedId(null);
    }
  };
  const editQueuedMessage = async (message: AssistantQueuedMessage) => {
    const conversationId = chat.activeConversationId();
    if (!conversationId) return;
    const draft = composerDraft(conversationId).trim();
    if (
      draft &&
      !(await prompts.confirm(t().replaceDraft, {
        title: t().editQueued,
      }))
    ) {
      return;
    }
    setComposerDraft(conversationId, message.text);
    removeQueuedMessage(conversationId, message.id);
    focusComposer();
  };

  createEffect(() => {
    const conversationId = chat.activeConversationId();
    const next = conversationId ? queuedMessagesFor(conversationId)[0] : undefined;
    if (!next || next.failed || sendingQueuedId() || chat.activeTurn() || chat.runStatus() !== "idle") return;
    queueMicrotask(() => void sendQueuedMessage(next));
  });

  const activeConversation = () =>
    conversations().find((conversation) => conversation.id === chat.activeConversationId()) ?? chat.conversation();
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
      setChatContextPresence(updated.projectId ? true : null);
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

  const useStarter = (starter: AssistantStarterAction) => {
    setComposerDraft(composerSessionKey(), starter.prompt);
    focusComposer();
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
    setComposerAttachments((all) => ({
      ...all,
      [sessionKey]: [...(all[sessionKey] ?? []), ...result.attachments],
    }));
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

  const pasteComposerResource = async (sessionKey: string) => {
    if (!requireComposerAttachmentsAvailable(sessionKey)) return;
    const ref = await cloudResourceClipboard.read(props.cloudUrl);
    if (!ref) throw new Error(t().clipboardNoResource);
    await addResolvedComposerResource(sessionKey, ref);
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
              onSendNow={(message) => void sendQueuedMessage(message)}
              onEdit={(message) => void editQueuedMessage(message)}
              onDelete={(message) => removeQueuedMessage(conversationId(), message.id)}
            />
          )}
        </Show>
        <Chat.Composer
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
              : input.intent === "queue"
                ? queueMessage(input.text)
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
            {
              id: "paste-resource",
              label: t().pasteResource,
              icon: "ti ti-clipboard-plus",
              disabled: composerAttachmentsBlocked(sessionKey()),
              onSelect: () => pasteComposerResource(sessionKey()),
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
                      const message = await openAssistantChatMessageSearch(conversation.id, locale());
                      if (message) await revealMessage(message);
                    },
                  },
                  {
                    id: "compact-context",
                    label: t().compactContext,
                    icon: "ti ti-package",
                    disabled: chat.running(),
                    onSelect: async () => {
                      if (!chat.activeConversationId()) return;
                      await chat.compactConversation({ modelProfileId: selectedModelId() || undefined });
                    },
                  },
                ]
              : []),
          ]}
          contextActions={[]}
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
    setQueuedMessages((current) => {
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
      <AppWorkspace class="flex-1 min-h-0">
        <AssistantSidebar
          conversations={conversations}
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
          <AppWorkspace.Main scroll={false}>
            <Show
              keyed
              when={projectView()}
              fallback={
                <Chat class="min-h-0 flex-1">
                  <div class="assistant-chat-layout">
                    <div class="contents">
                      <section class="assistant-chat-messages min-h-0 overflow-hidden" data-scroll-preserve="assistant-messages">
                        <Show
                          when={emptyChat()}
                          fallback={
                            <AiChatActionsProvider
                              actions={{
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
                                onOpenFile: (path) => void openFiles(path),
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
                      </section>

                      <Show when={!emptyChat()}>
                        <div class="assistant-chat-composer shrink-0 px-[var(--ui-space-section)] pb-[var(--ui-space-section)] pt-2">
                          <div class="mx-auto flex max-w-3xl flex-col gap-2">
                            <ComposerNotices />
                            <AssistantComposer />
                            <Show when={activeConversation() && chatContextPresence() === true ? activeConversation() : null}>
                              {(conversation) => (
                                <div class="flex justify-end lg:hidden">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      void openAssistantChatContextDialog(conversation().id, activeConversationProject(), liveHub)
                                    }
                                  >
                                    <i class="ti ti-adjustments-horizontal" />
                                    Context
                                  </Button>
                                </div>
                              )}
                            </Show>
                          </div>
                        </div>
                      </Show>
                    </div>
                    <Show when={activeConversation()}>
                      {(conversation) => (
                        <div class="contents">
                          <AssistantChatContextPanel
                            chatId={conversation().id}
                            project={activeConversationProject()}
                            initial={props.initialContext?.chatId === conversation().id ? props.initialContext : null}
                            onPresenceChange={setChatContextPresence}
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
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </AssistantLiveProvider>
  );
}
