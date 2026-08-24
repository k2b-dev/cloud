import { type Accessor, createMemo, createSignal, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { type AiAttachmentRef, aiAttachmentMarker } from "../attachments";
import { type AiStreamEvent, type AiTurnBlock, type AiTurnSnapshot, steerMessageBlockId } from "../protocol";
import { type AiResourceMarker, aiResourceMarker } from "../resource-markers";
import type {
  AiConversation,
  AiConversationTimelineEntry,
  AiDraftContentPart,
  AiMessageFeedback,
  AiStoredMessage,
  AiTurn,
  AiTurnSteer,
  AiUserContentPart,
} from "../types";
import {
  type AiChatProjection,
  activeTurnFromSnapshot,
  emptyProjection,
  mergeActiveTurn,
  reconcileActiveTurnActions,
  reduceProjection,
  visibleMessages,
} from "./projection";
import { type AiConversationStreamTransport, type AiStreamHandle, aiSseConversationStreamTransport } from "./transport";

type ComposerDraftInput = {
  message?: string;
  content?: AiUserContentPart[];
  files?: File[];
  resources?: AiResourceMarker[];
  storedFiles?: Array<{ path: string; mediaType: string; size: number; version: number }>;
};

export type AiChatRunStatus = "idle" | "streaming" | "waiting_for_action" | "stopping" | "failed";
export type AiStreamStatus = "idle" | "connecting" | "open" | "reconnecting";

export type AiFrontendToolHandler = (request: {
  name: string;
  callId: string;
  args: unknown;
  turnId: string;
}) => unknown | Promise<unknown>;

type AiConversationDetail = {
  conversation: AiConversation;
  messages: AiStoredMessage[];
  hasMoreMessages?: boolean;
  activeTurn: AiTurnSnapshot | null;
  timeline?: AiConversationTimelineEntry[];
};

type AiMessagesPage = { messages: AiStoredMessage[]; hasMore: boolean };
type SubmitTurnResult = { turn: AiTurn; message: AiStoredMessage };
type AiStreamSession = { conversationId: string; generation: number };

const detailToProjection = (detail: AiConversationDetail): AiChatProjection => ({
  conversation: detail.conversation,
  messages: detail.messages,
  activeTurn: activeTurnFromSnapshot(detail.activeTurn),
});

const projectionForConversationOpen = (cached: AiChatProjection | undefined, conversation: AiConversation | null): AiChatProjection =>
  cached ?? emptyProjection(conversation);

const claimFrontendCall = (handled: Set<string>, inFlight: Set<string>, key: string): boolean => {
  if (handled.has(key) || inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
};

const settleFrontendCall = (handled: Set<string>, inFlight: Set<string>, key: string, submitted: boolean): void => {
  inFlight.delete(key);
  if (submitted) handled.add(key);
};

const isCurrentStreamSession = (current: AiStreamSession | null, candidate: AiStreamSession): boolean =>
  current?.conversationId === candidate.conversationId && current.generation === candidate.generation;

const DEFAULT_RUN_ERROR = "Assistant response failed.";

const conversationRunError = (conversation: AiConversation | null | undefined): string | null =>
  conversation?.runStatus === "failed" ? conversation.runError?.trim() || DEFAULT_RUN_ERROR : null;

const runErrorFromEvent = (event: AiStreamEvent, activeTurnId: string | null | undefined): string | null | undefined => {
  if (event.type === "state") return conversationRunError(event.conversation);
  if (event.type !== "turn_finished" || event.turnId !== activeTurnId) return undefined;
  return event.status === "failed" ? event.error?.trim() || DEFAULT_RUN_ERROR : null;
};

export type CreateAiChatControllerOptions = {
  /** Global AI API base path, normally "/api/ai". */
  baseUrl: string;
  params?: Record<string, string> | Accessor<Record<string, string>>;
  initialConversationId?: string | null;
  initialDetail?: AiConversationDetail | null;
  initialTimeline?: AiConversationTimelineEntry[];
  initialError?: string | null;
  /** Persist owner read state for conversation-list unread indicators. */
  trackViewedState?: boolean;
  frontendTools?: Record<string, AiFrontendToolHandler>;
  /** Overrides the default SSE transport, for example with a shared WebSocket channel. */
  streamTransport?: AiConversationStreamTransport;
};

const isAccessor = <T>(value: T | Accessor<T>): value is Accessor<T> => typeof value === "function";

const readError = async (response: Response, fallback: string): Promise<string> => {
  const body = await response.json().catch(() => null);
  return body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : fallback;
};

const reconcileSteerBlocks = (blocks: AiTurnBlock[], localId: string, steer: AiTurnSteer): AiTurnBlock[] => {
  const stableId = steerMessageBlockId(steer.id);
  const stableExists = blocks.some((block) => block.id === stableId);
  const next = blocks.filter((block) => block.id !== localId);
  if (!stableExists) {
    next.push({ id: stableId, kind: "steer_message", steerId: steer.id, text: steer.text, status: "pending" });
  }
  return next;
};

const failSteerBlock = (blocks: AiTurnBlock[], blockId: string): AiTurnBlock[] =>
  blocks.map((block) => (block.id === blockId && block.kind === "steer_message" ? { ...block, status: "failed" } : block));

const completeFrontendToolBlock = (blocks: AiTurnBlock[], callId: string, result: unknown): AiTurnBlock[] =>
  blocks.map((block) =>
    block.kind === "tool" && block.callId === callId && block.status === "awaiting_client"
      ? { ...block, status: "completed", result }
      : block,
  );

const isActiveConversationLoading = (activeConversationId: string | null, loadingConversationId: string | null): boolean =>
  activeConversationId !== null && loadingConversationId === activeConversationId;

export const createAiChatController = (options: CreateAiChatControllerOptions) => {
  const [activeConversationId, setActiveConversationIdSignal] = createSignal<string | null>(options.initialConversationId ?? null);
  const [globalError, setGlobalError] = createSignal<string | null>(options.initialError ?? null);
  const [runError, setRunError] = createSignal<string | null>(conversationRunError(options.initialDetail?.conversation));
  const [runStatusRaw, setRunStatusRaw] = createSignal<AiChatRunStatus | null>(null);
  const [streamStatus, setStreamStatus] = createSignal<AiStreamStatus>("idle");
  const initialProjection = options.initialDetail ? detailToProjection(options.initialDetail) : emptyProjection();
  const [state, setState] = createStore<AiChatProjection>(initialProjection);

  // Cache of projections for conversations opened this session (fast switching).
  const cache = new Map<string, AiChatProjection>();
  const preparedAttachmentRefs = new Map<string, WeakMap<File, Promise<AiAttachmentRef & { version: number }>>>();
  if (options.initialConversationId && options.initialDetail) cache.set(options.initialConversationId, initialProjection);
  // Infinite scroll state per conversation (history is windowed, oldest first).
  const [hasMoreByConversation, setHasMoreByConversation] = createSignal<Record<string, boolean>>({});
  const [loadingOlderConversationId, setLoadingOlderConversationId] = createSignal<string | null>(null);
  const [loadingConversationId, setLoadingConversationId] = createSignal<string | null>(null);
  const [timelineByConversation, setTimelineByConversation] = createSignal<Record<string, AiConversationTimelineEntry[]>>(
    options.initialConversationId && options.initialTimeline ? { [options.initialConversationId]: options.initialTimeline } : {},
  );
  const [loadingTimelineConversationId, setLoadingTimelineConversationId] = createSignal<string | null>(null);
  const setHasMore = (conversationId: string, hasMore: boolean) =>
    setHasMoreByConversation((current) => ({ ...current, [conversationId]: hasMore }));
  const handledFrontendCalls = new Set<string>();
  const inFlightFrontendCalls = new Set<string>();
  const abortRequests = new Map<string, Promise<boolean>>();
  let stream: AiStreamHandle | null = null;
  let streamSession: AiStreamSession | null = null;
  let streamGeneration = 0;
  let conversationOpenGeneration = 0;
  let historyTargetSeq: number | null = null;
  let historyLoadPromise: Promise<boolean> | null = null;
  let draftSaveQueue: Promise<unknown> = Promise.resolve();
  let conversationCreationPromise: Promise<AiConversation | null> | null = null;

  const isActiveConversation = (conversationId: string) => activeConversationId() === conversationId;
  const timeline = () => {
    const conversationId = activeConversationId();
    return conversationId ? (timelineByConversation()[conversationId] ?? []) : [];
  };
  const setTimeline = (conversationId: string, entries: AiConversationTimelineEntry[]) =>
    setTimelineByConversation((current) => ({ ...current, [conversationId]: entries }));
  const setConversationError = (conversationId: string, message: string) => {
    if (isActiveConversation(conversationId)) setGlobalError(message);
  };
  const invalidateInactiveCache = (conversationId: string): boolean => {
    if (isActiveConversation(conversationId)) return false;
    cache.delete(conversationId);
    return true;
  };

  const currentParams = () => (options.params ? (isAccessor(options.params) ? options.params() : options.params) : {});
  const url = (path: string, extra?: Record<string, string>) => {
    const params = new URLSearchParams({ ...currentParams(), ...extra }).toString();
    return `${options.baseUrl}${path}${params ? `?${params}` : ""}`;
  };

  const request = async <T>(path: string, init: RequestInit, fallback: string): Promise<T> => {
    const response = await fetch(url(path), { ...init, headers: { "Content-Type": "application/json", ...init.headers } });
    if (!response.ok) throw new Error(await readError(response, fallback));
    return (await response.json()) as T;
  };

  const setActiveError = (message: string | null) => {
    if (activeConversationId()) setGlobalError(message);
    else setGlobalError(message);
  };
  const clearErrors = () => {
    setGlobalError(null);
    setRunError(null);
  };
  const error = () => globalError() ?? runError();

  const activeTurn = () => state.activeTurn;
  const messages = createMemo(() => visibleMessages(state));
  const runStatus = (): AiChatRunStatus => {
    const override = runStatusRaw();
    if (override) return override;
    const turn = state.activeTurn;
    if (!turn) return "idle";
    return turn.status === "waiting_for_action" ? "waiting_for_action" : "streaming";
  };
  const running = () => {
    const status = runStatus();
    return status === "streaming" || status === "waiting_for_action" || status === "stopping";
  };

  // ---- streaming --------------------------------------------------------

  const reduceEvent = (conversationId: string, event: AiStreamEvent) => {
    const next = reduceProjection({ conversation: state.conversation, messages: state.messages, activeTurn: state.activeTurn }, event);
    setState(reconcile(next, { key: "id", merge: true }));
    cache.set(conversationId, next);
  };

  /**
   * Compaction rewrites history (archives messages, inserts the summary) — the
   * additive event fold cannot express that, so the turn ends with one atomic
   * detail refetch. The finished compaction block stays visible until the fresh
   * state replaces it in a single step.
   */
  const foldCompaction = async (session: AiStreamSession, event: AiStreamEvent) => {
    const detail = await loadDetail(session.conversationId, () => isCurrentStreamSession(streamSession, session));
    if (!isCurrentStreamSession(streamSession, session)) return;
    if (detail) {
      setProjection(detailToProjection(detail), session.conversationId);
      setHasMore(session.conversationId, detail.hasMoreMessages ?? false);
      if (detail.timeline) setTimeline(session.conversationId, detail.timeline);
    } else reduceEvent(session.conversationId, event);
    setRunStatusRaw(null);
    void markConversationViewed(session.conversationId);
  };

  const applyEvent = (session: AiStreamSession, event: AiStreamEvent) => {
    if (!isCurrentStreamSession(streamSession, session)) return;
    const conversationId = session.conversationId;

    if (event.type === "state") setHasMore(conversationId, event.hasMoreMessages ?? false);
    const nextRunError = runErrorFromEvent(event, state.activeTurn?.turnId);
    if (nextRunError !== undefined) setRunError(nextRunError);

    if (
      event.type === "turn_finished" &&
      state.activeTurn?.turnId === event.turnId &&
      state.activeTurn.blocks.some((block) => block.kind === "compaction")
    ) {
      void foldCompaction(session, event);
      return;
    }

    reduceEvent(conversationId, event);
    if (event.type === "state" && loadingConversationId() === conversationId) setLoadingConversationId(null);
    if (runStatusRaw() && runStatusRaw() !== "stopping") setRunStatusRaw(null);

    if (event.type === "turn_finished") {
      setRunStatusRaw(null);
      void markConversationViewed(conversationId);
      void refreshTimeline(conversationId);
    }
    runFrontendTools();
  };

  const closeStream = () => {
    stream?.close();
    stream = null;
    streamSession = null;
    setStreamStatus("idle");
  };

  const openStream = (conversationId: string) => {
    if (streamSession?.conversationId === conversationId && stream) return;
    closeStream();
    const session = { conversationId, generation: ++streamGeneration };
    streamSession = session;
    stream = (options.streamTransport ?? aiSseConversationStreamTransport).subscribe({
      conversationId,
      url: url(`/conversations/${conversationId}/stream`),
      onStatus: (status) => {
        if (isCurrentStreamSession(streamSession, session)) setStreamStatus(status);
      },
      onEvent: (event) => applyEvent(session, event),
      onError: (error) => {
        if (!isCurrentStreamSession(streamSession, session)) return;
        setStreamStatus("idle");
        setConversationError(conversationId, error.message);
      },
    });
  };

  // ---- frontend tools ---------------------------------------------------

  const runFrontendTools = () => {
    const conversationId = activeConversationId();
    const turn = state.activeTurn;
    if (!conversationId || !turn || turn.status !== "waiting_for_action") return;
    for (const block of turn.blocks) {
      if (block.kind !== "tool" || block.status !== "awaiting_client") continue;
      const mode = block.frontendMode ?? "client";
      // client_interaction tools resolve through their rendered UI; client_view
      // (card) is resolved inline by the executor and never has a pending action —
      // submitting for either would race a request that isn't ours to answer.
      if (mode !== "client") continue;
      const key = `${turn.turnId}:${block.callId}`;
      if (!claimFrontendCall(handledFrontendCalls, inFlightFrontendCalls, key)) continue;
      void executeFrontendTool(conversationId, turn.turnId, block.callId, block.name, block.args).then((submitted) => {
        settleFrontendCall(handledFrontendCalls, inFlightFrontendCalls, key, submitted);
      });
    }
  };

  const executeFrontendTool = async (
    conversationId: string,
    turnId: string,
    callId: string,
    name: string,
    args: unknown,
  ): Promise<boolean> => {
    const handler = options.frontendTools?.[name];
    // Never fake-answer a client tool: without a registered handler the
    // request must stay pending for whatever UI renders it.
    if (!handler) {
      console.warn(`No frontend handler registered for AI tool "${name}" — leaving the action request pending.`);
      return false;
    }
    try {
      const result = await handler({ name, callId, args, turnId });
      return submitTurnActionForConversation(conversationId, turnId, callId, { type: "tool_result", result });
    } catch (toolError) {
      return submitTurnActionForConversation(conversationId, turnId, callId, {
        type: "tool_result",
        result: { error: toolError instanceof Error ? toolError.message : "Frontend tool failed" },
      });
    }
  };

  // ---- conversation loading --------------------------------------------

  const markConversationViewed = async (conversationId: string): Promise<void> => {
    if (!options.trackViewedState) return;
    if (state.conversation?.id === conversationId) setState("conversation", "unreadCompletion", false);
    try {
      await request(`/conversations/${conversationId}/viewed`, { method: "POST" }, "Failed to mark conversation as viewed");
    } catch {}
  };

  const loadDetail = async (conversationId: string, shouldReportError: () => boolean): Promise<AiConversationDetail | null> => {
    try {
      return await request<AiConversationDetail>(`/conversations/${conversationId}`, { method: "GET" }, "Failed to open conversation");
    } catch (loadError) {
      if (shouldReportError()) {
        setConversationError(conversationId, loadError instanceof Error ? loadError.message : "Failed to open conversation");
      }
      return null;
    }
  };

  const refreshTimeline = async (conversationId = activeConversationId()): Promise<void> => {
    if (!conversationId) return;
    setLoadingTimelineConversationId(conversationId);
    try {
      const entries = await request<AiConversationTimelineEntry[]>(
        `/conversations/${conversationId}/timeline`,
        { method: "GET" },
        "Failed to load conversation timeline",
      );
      if (isActiveConversation(conversationId)) setTimeline(conversationId, entries);
    } catch {
      // The navigator is optional; transcript navigation remains fully usable.
    } finally {
      if (loadingTimelineConversationId() === conversationId) setLoadingTimelineConversationId(null);
    }
  };

  const setProjection = (projection: AiChatProjection, conversationId: string) => {
    const next = {
      ...projection,
      activeTurn:
        state.conversation?.id === conversationId ? mergeActiveTurn(state.activeTurn, projection.activeTurn) : projection.activeTurn,
    };
    cache.set(conversationId, next);
    setState(reconcile(next, { key: "id", merge: true }));
  };

  const openConversation = async (conversationId: string) => {
    if (activeConversationId() === conversationId && state.conversation?.id === conversationId) {
      void markConversationViewed(conversationId);
      return "current" as const;
    }
    const generation = ++conversationOpenGeneration;
    void markConversationViewed(conversationId);
    setGlobalError(null);
    setRunStatusRaw(null);

    const cached = cache.get(conversationId);
    const conversation = cached?.conversation ?? null;
    setRunError(conversationRunError(cached?.conversation ?? conversation));
    setActiveConversationIdSignal(conversationId);
    setState(reconcile(projectionForConversationOpen(cached, conversation), { key: "id", merge: true }));
    setLoadingConversationId(cached ? null : conversationId);

    openStream(conversationId);
    const detail = await loadDetail(
      conversationId,
      () => activeConversationId() === conversationId && generation === conversationOpenGeneration,
    );
    if (detail && activeConversationId() === conversationId && generation === conversationOpenGeneration) {
      const viewedDetail = { ...detail, conversation: { ...detail.conversation, unreadCompletion: false } };
      setRunError(conversationRunError(viewedDetail.conversation));
      // A cached view may hold history the fresh window doesn't — preserve it
      // (same rule as the SSE state snapshot) so the scrollback never shrinks.
      const windowOldest = detail.messages[0]?.seq;
      const preservedOlder = cached && windowOldest !== undefined ? cached.messages.filter((message) => message.seq < windowOldest) : [];
      setProjection({ ...detailToProjection(viewedDetail), messages: [...preservedOlder, ...detail.messages] }, conversationId);
      if (preservedOlder.length === 0) setHasMore(conversationId, detail.hasMoreMessages ?? false);
      if (detail.timeline) setTimeline(conversationId, detail.timeline);
      runFrontendTools();
      if (loadingConversationId() === conversationId) setLoadingConversationId(null);
      return "opened" as const;
    }
    if (generation === conversationOpenGeneration && loadingConversationId() === conversationId) setLoadingConversationId(null);
    return generation === conversationOpenGeneration ? ("failed" as const) : ("stale" as const);
  };

  const refreshActiveConversation = async (): Promise<void> => {
    const conversationId = activeConversationId();
    if (!conversationId) return;
    const detail = await request<AiConversationDetail>(
      `/conversations/${conversationId}`,
      { method: "GET" },
      "Failed to refresh conversation",
    );
    if (!isActiveConversation(conversationId)) return;
    const windowOldest = detail.messages[0]?.seq;
    const preservedOlder = windowOldest === undefined ? [] : state.messages.filter((message) => message.seq < windowOldest);
    setProjection({ ...detailToProjection(detail), messages: [...preservedOlder, ...detail.messages] }, conversationId);
    if (preservedOlder.length === 0) setHasMore(conversationId, detail.hasMoreMessages ?? false);
    if (detail.timeline) setTimeline(conversationId, detail.timeline);
    setRunError(conversationRunError(detail.conversation));
  };

  const requestMessagesPage = async (conversationId: string, before: number, limit: number): Promise<AiMessagesPage> => {
    const response = await fetch(url(`/conversations/${conversationId}/messages`, { before: String(before), limit: String(limit) }));
    if (!response.ok) throw new Error(await readError(response, "Failed to load older messages"));
    return (await response.json()) as AiMessagesPage;
  };

  const mergeOlderMessages = (conversationId: string, page: AiMessagesPage): boolean => {
    if (!isActiveConversation(conversationId)) return false;
    const known = new Set(state.messages.map((message) => message.id));
    const fresh = page.messages.filter((message) => !known.has(message.id));
    if (fresh.length > 0) setState("messages", (prev) => [...fresh, ...prev]);
    setHasMore(conversationId, page.hasMore);
    cache.set(conversationId, { conversation: state.conversation, messages: state.messages, activeTurn: state.activeTurn });
    return fresh.length > 0;
  };

  const fetchOlderMessagesPage = async (conversationId: string, limit: number): Promise<boolean> => {
    if (!(hasMoreByConversation()[conversationId] ?? false)) return false;
    const oldest = state.messages[0]?.seq;
    if (oldest === undefined) return false;
    return mergeOlderMessages(conversationId, await requestMessagesPage(conversationId, oldest, limit));
  };

  /** Load one older page above the current window (infinite scroll). Returns whether anything was prepended. */
  const loadOlderMessages = async (): Promise<boolean> => {
    const conversationId = activeConversationId();
    if (!conversationId || loadingOlderConversationId() === conversationId || historyLoadPromise) return false;
    setGlobalError(null);
    setLoadingOlderConversationId(conversationId);
    try {
      return await fetchOlderMessagesPage(conversationId, 50);
    } catch (loadError) {
      const error = loadError instanceof Error ? loadError : new Error("Failed to load older messages");
      setConversationError(conversationId, error.message);
      throw error;
    } finally {
      if (loadingOlderConversationId() === conversationId) setLoadingOlderConversationId(null);
    }
  };

  /** Ensure history stays contiguous while revealing a timeline target. */
  const loadHistoryThroughSeq = (targetSeq: number): Promise<boolean> => {
    const conversationId = activeConversationId();
    if (!conversationId) return Promise.resolve(false);
    historyTargetSeq = historyTargetSeq === null ? targetSeq : Math.min(historyTargetSeq, targetSeq);
    if (state.messages.some((message) => message.seq <= targetSeq)) return Promise.resolve(true);
    if (historyLoadPromise) return historyLoadPromise.then((reached) => reached || loadHistoryThroughSeq(targetSeq));

    historyLoadPromise = (async () => {
      setGlobalError(null);
      setLoadingOlderConversationId(conversationId);
      try {
        let before = state.messages[0]?.seq;
        let hasMore = hasMoreByConversation()[conversationId] ?? false;
        let accumulated: AiStoredMessage[] = [];
        while (isActiveConversation(conversationId) && before !== undefined) {
          const target = historyTargetSeq;
          if (target === null || before <= target) break;
          if (!hasMore) return false;
          const page = await requestMessagesPage(conversationId, before, 200);
          if (page.messages.length === 0) return false;
          accumulated = [...page.messages, ...accumulated];
          before = page.messages[0]?.seq;
          hasMore = page.hasMore;
        }
        if (!isActiveConversation(conversationId)) return false;
        if (accumulated.length > 0) mergeOlderMessages(conversationId, { messages: accumulated, hasMore });
        const target = historyTargetSeq;
        return target !== null && state.messages.some((message) => message.seq <= target);
      } catch (loadError) {
        const error = loadError instanceof Error ? loadError : new Error("Failed to load conversation history");
        setConversationError(conversationId, error.message);
        return false;
      } finally {
        historyTargetSeq = null;
        historyLoadPromise = null;
        if (loadingOlderConversationId() === conversationId) setLoadingOlderConversationId(null);
      }
    })();
    return historyLoadPromise;
  };

  const setActiveConversationId = (conversationId: string | null) => {
    if (conversationId) void openConversation(conversationId);
    else {
      conversationOpenGeneration += 1;
      clearErrors();
      setActiveConversationIdSignal(null);
      historyTargetSeq = null;
      setLoadingConversationId(null);
      closeStream();
      setState(reconcile(emptyProjection(), { key: "id", merge: true }));
    }
  };

  const createConversation = async (
    input: {
      title?: string;
      projectId?: string;
      draft?: { content: AiDraftContentPart[] };
      preloadTools?: Array<{ name: string } | { appId: string; kind: "query" | "action"; id: string }>;
    } = {},
  ) => {
    const generation = ++conversationOpenGeneration;
    clearErrors();
    try {
      const conversation = await request<AiConversation>(
        `/conversations`,
        { method: "POST", body: JSON.stringify(input) },
        "Failed to create conversation",
      );
      const projection = emptyProjection(conversation);
      cache.set(conversation.id, projection);
      setHasMore(conversation.id, false);
      if (generation !== conversationOpenGeneration) return conversation;
      setState(reconcile(projection, { key: "id", merge: true }));
      setActiveConversationIdSignal(conversation.id);
      setLoadingConversationId(null);
      openStream(conversation.id);
      void markConversationViewed(conversation.id);
      return conversation;
    } catch (createError) {
      if (generation === conversationOpenGeneration) {
        setGlobalError(createError instanceof Error ? createError.message : "Failed to create conversation");
      }
      return null;
    }
  };

  const ensureConversation = async (): Promise<string | null> => {
    const active = activeConversationId();
    if (active) return active;

    if (!conversationCreationPromise) {
      const creation = createConversation();
      conversationCreationPromise = creation;
      void creation.then(() => {
        if (conversationCreationPromise === creation) conversationCreationPromise = null;
      });
    }
    return (await conversationCreationPromise)?.id ?? null;
  };

  // ---- commands ---------------------------------------------------------

  /** Upload one attachment into the conversation file store; returns its reference. */
  const uploadConversationFile = async (conversationId: string, file: File): Promise<AiAttachmentRef & { version: number }> => {
    let prepared = preparedAttachmentRefs.get(conversationId);
    if (!prepared) {
      prepared = new WeakMap();
      preparedAttachmentRefs.set(conversationId, prepared);
    }
    const existing = prepared.get(file);
    if (existing) return existing;
    const upload = (async () => {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(url(`/conversations/${conversationId}/files`), { method: "POST", body: form });
      if (!response.ok) throw new Error(await readError(response, `Failed to upload ${file.name}`));
      const body = (await response.json()) as { file: { path: string; mediaType: string; size: number; version: number } };
      return { path: body.file.path, mediaType: body.file.mediaType, size: body.file.size, version: body.file.version };
    })();
    prepared.set(file, upload);
    try {
      return await upload;
    } catch (error) {
      if (prepared.get(file) === upload) prepared.delete(file);
      throw error;
    }
  };

  const persistComposerDraft = async (
    input: ComposerDraftInput,
    conversationId: string | null,
  ): Promise<{ conversationId: string; content: AiDraftContentPart[]; revision: number } | null> => {
    if (!conversationId) return null;
    const conversation = isActiveConversation(conversationId) ? state.conversation : cache.get(conversationId)?.conversation;
    if (!conversation) return null;

    let uploaded: Array<AiAttachmentRef & { version: number }> = [];
    try {
      uploaded = input.files?.length ? await Promise.all(input.files.map((file) => uploadConversationFile(conversationId, file))) : [];
    } catch (uploadError) {
      setConversationError(conversationId, uploadError instanceof Error ? uploadError.message : "Attachment upload failed");
      return null;
    }

    const textParts: AiDraftContentPart[] = [];
    const message = input.message?.trim();
    if (message && !input.content?.some((part) => typeof part !== "string" && part.type === "text")) {
      textParts.push({ type: "text", text: message });
    }
    for (const part of input.content ?? []) {
      if (typeof part === "string") {
        if (part.trim()) textParts.push({ type: "text", text: part });
      } else if (part.type === "text" && part.text.trim()) {
        textParts.push({ type: "text", text: part.text });
      }
    }
    const content: AiDraftContentPart[] = [
      ...textParts,
      ...(input.resources ?? []).map((resource) => ({ type: "resource" as const, ...resource })),
      ...(input.storedFiles ?? []).map((file) => ({ type: "file" as const, ...file })),
      ...uploaded.map((file) => ({ type: "file" as const, ...file })),
    ];
    try {
      const draft = await request<AiConversation["draft"]>(
        `/conversations/${conversationId}/draft`,
        { method: "PUT", body: JSON.stringify({ expectedRevision: conversation.draft.revision, content }) },
        "Failed to save conversation draft",
      );
      const nextConversation = { ...conversation, draft };
      const projection = isActiveConversation(conversationId)
        ? { conversation: nextConversation, messages: state.messages, activeTurn: state.activeTurn }
        : { ...(cache.get(conversationId) ?? emptyProjection(nextConversation)), conversation: nextConversation };
      cache.set(conversationId, projection);
      if (isActiveConversation(conversationId)) setState("conversation", nextConversation);
      return { conversationId, content, revision: draft.revision };
    } catch (draftError) {
      setConversationError(conversationId, draftError instanceof Error ? draftError.message : "Failed to save conversation draft");
      return null;
    }
  };

  const queueDraftOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const queued = draftSaveQueue.then(operation);
    draftSaveQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };

  const saveDraft = (input: ComposerDraftInput) => {
    const targetConversation = ensureConversation();
    return queueDraftOperation(async () => persistComposerDraft(input, await targetConversation));
  };

  const send = (input: ComposerDraftInput & { modelProfileId?: string }): Promise<boolean> => {
    if (!isComposerDraftSendable(input)) return Promise.resolve(false);
    const targetConversation = ensureConversation();
    return queueDraftOperation(async () => {
      const savedDraft = await persistComposerDraft(input, await targetConversation);
      if (!savedDraft) return false;
      const conversationId = savedDraft.conversationId;
      if (isActiveConversation(conversationId) && running()) return false;

      if (isActiveConversation(conversationId)) clearErrors();
      const baseProjection = isActiveConversation(conversationId)
        ? { conversation: state.conversation, messages: [...state.messages], activeTurn: state.activeTurn }
        : (cache.get(conversationId) ?? emptyProjection());

      // Optimistic view renders attachments through the same marker format the server persists.
      const optimisticContent: AiUserContentPart[] = [
        ...savedDraft.content.flatMap((part) => {
          if (part.type === "text") return [{ type: "text" as const, text: part.text }];
          if (part.type === "file") return [{ type: "text" as const, text: aiAttachmentMarker(part) }];
          return [
            {
              type: "text" as const,
              text: aiResourceMarker({ ref: part.ref, title: part.title, icon: part.icon, href: part.href }),
            },
          ];
        }),
      ];

      // Optimistic: show the user message immediately.
      const optimistic: AiStoredMessage = {
        id: `pending-${Date.now()}`,
        shortId: `pending-${Date.now()}`,
        conversationId,
        seq: (baseProjection.messages.at(-1)?.seq ?? 0) + 1,
        kind: "message",
        message: { role: "user", content: optimisticContent },
        loopId: null,
        modelProfileId: null,
        providerModel: null,
        usage: null,
        stopReason: null,
        loopAggregate: null,
        loopDoneReason: null,
        compactedAt: null,
        meta: null,
        createdAt: new Date().toISOString(),
      };
      const optimisticProjection = { ...baseProjection, messages: [...baseProjection.messages, optimistic] };
      cache.set(conversationId, optimisticProjection);
      if (isActiveConversation(conversationId)) {
        setState("messages", (prev) => [...prev, optimistic]);
        setRunStatusRaw("streaming");
      }

      try {
        const result = await request<SubmitTurnResult>(
          `/conversations/${conversationId}/turns`,
          {
            method: "POST",
            body: JSON.stringify({
              draftRevision: savedDraft.revision,
              modelProfileId: input.modelProfileId,
            }),
          },
          "AI request failed",
        );
        if (invalidateInactiveCache(conversationId)) return true;
        // Replace the optimistic message with the persisted one.
        setState("messages", (prev) => prev.map((message) => (message.id === optimistic.id ? result.message : message)));
        setState(
          "activeTurn",
          (current) =>
            current ?? {
              turnId: result.turn.id,
              attempt: 0,
              seq: 0,
              status: "running",
              blocks: [],
              modelProfileId: result.turn.modelProfileId,
            },
        );
        if (state.conversation) {
          setState("conversation", "draft", {
            content: [],
            revision: savedDraft.revision + 1,
            updatedAt: new Date().toISOString(),
          });
        }
        cache.set(conversationId, { conversation: state.conversation, messages: state.messages, activeTurn: state.activeTurn });
        void refreshTimeline(conversationId);
        if (input.files?.length) {
          const prepared = preparedAttachmentRefs.get(conversationId);
          for (const file of input.files) prepared?.delete(file);
        }
        return true;
      } catch (sendError) {
        if (invalidateInactiveCache(conversationId)) return false;
        setState("messages", (prev) => prev.filter((message) => message.id !== optimistic.id));
        cache.set(conversationId, { conversation: state.conversation, messages: state.messages, activeTurn: state.activeTurn });
        setRunStatusRaw("failed");
        setConversationError(conversationId, sendError instanceof Error ? sendError.message : "AI request failed");
        return false;
      }
    });
  };

  const submitSteer = async (input: { text: string; clientRequestId: string; blockId: string }) => {
    const conversationId = activeConversationId();
    const turn = state.activeTurn;
    if (!conversationId || !turn || runStatus() === "stopping") return false;

    try {
      const result = await request<AiTurnSteer>(
        `/conversations/${conversationId}/turns/${turn.turnId}/steer`,
        { method: "POST", body: JSON.stringify({ message: input.text, clientRequestId: input.clientRequestId }) },
        "Failed to steer the current response",
      );
      if (invalidateInactiveCache(conversationId)) return true;
      setState("activeTurn", (current) => {
        if (!current || current.turnId !== turn.turnId) return current;
        return { ...current, blocks: reconcileSteerBlocks(current.blocks, input.blockId, result) };
      });
      cache.set(conversationId, { conversation: state.conversation, messages: state.messages, activeTurn: state.activeTurn });
      void refreshTimeline(conversationId);
      return true;
    } catch (steerError) {
      if (invalidateInactiveCache(conversationId)) return true;
      setState("activeTurn", (current) =>
        current
          ? {
              ...current,
              blocks: failSteerBlock(current.blocks, input.blockId),
            }
          : current,
      );
      setConversationError(conversationId, steerError instanceof Error ? steerError.message : "Failed to steer the current response");
      return true;
    }
  };

  const steer = async (message: string) => {
    const text = message.trim();
    const turn = state.activeTurn;
    if (!text || !turn || runStatus() === "stopping") return false;
    clearErrors();
    const clientRequestId =
      typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const blockId = `steer-request-${clientRequestId}`;
    setState("activeTurn", (current) =>
      current
        ? {
            ...current,
            blocks: [
              ...current.blocks,
              { id: blockId, kind: "steer_message" as const, steerId: clientRequestId, text, status: "pending" as const },
            ],
          }
        : current,
    );
    const conversationId = activeConversationId();
    if (conversationId)
      cache.set(conversationId, { conversation: state.conversation, messages: state.messages, activeTurn: state.activeTurn });
    return submitSteer({ text, clientRequestId, blockId });
  };

  const retrySteer = async (block: Extract<AiTurnSnapshot["blocks"][number], { kind: "steer_message" }>) => {
    if (block.status !== "failed") return false;
    clearErrors();
    setState("activeTurn", (current) =>
      current
        ? {
            ...current,
            blocks: current.blocks.map((candidate) =>
              candidate.id === block.id && candidate.kind === "steer_message" ? { ...candidate, status: "pending" as const } : candidate,
            ),
          }
        : current,
    );
    const conversationId = activeConversationId();
    if (conversationId)
      cache.set(conversationId, { conversation: state.conversation, messages: state.messages, activeTurn: state.activeTurn });
    return submitSteer({ text: block.text, clientRequestId: block.steerId, blockId: block.id });
  };

  /** Download URL for a conversation VFS file (present blocks, attachment chips). */
  const fileContentUrl = (path: string): string | null => {
    const conversationId = activeConversationId();
    if (!conversationId) return null;
    return url(`/conversations/${conversationId}/files/content`, { path });
  };

  const abort = (): Promise<boolean> => {
    const turn = state.activeTurn;
    const conversationId = activeConversationId();
    if (!turn || !conversationId) return Promise.resolve(false);
    const key = `${conversationId}:${turn.turnId}`;
    const inFlight = abortRequests.get(key);
    if (inFlight) return inFlight;

    clearErrors();
    setRunStatusRaw("stopping");
    const requestPromise = request(
      `/conversations/${conversationId}/turns/${turn.turnId}/abort`,
      { method: "POST" },
      "Failed to stop AI turn",
    )
      .then(() => true)
      .catch((abortError) => {
        if (isActiveConversation(conversationId) && state.activeTurn?.turnId === turn.turnId) {
          // The server did not accept the abort, so the existing turn is still
          // authoritative and Stop must remain available for another attempt.
          setRunStatusRaw(null);
          setConversationError(conversationId, abortError instanceof Error ? abortError.message : "Failed to stop AI turn");
        }
        return false;
      })
      .finally(() => {
        abortRequests.delete(key);
      });
    abortRequests.set(key, requestPromise);
    return requestPromise;
  };

  const compactConversation = async (input: { modelProfileId?: string } = {}) => {
    const conversationId = activeConversationId();
    if (!conversationId) {
      setGlobalError("Open a chat before compacting context.");
      return false;
    }
    if (running()) {
      setGlobalError("Stop the current response before compacting context.");
      return false;
    }
    clearErrors();
    setRunStatusRaw("streaming");
    try {
      await request(`/conversations/${conversationId}/compact`, { method: "POST", body: JSON.stringify(input) }, "AI compaction failed");
      return true;
    } catch (compactError) {
      if (!isActiveConversation(conversationId)) return false;
      setRunStatusRaw("failed");
      setConversationError(conversationId, compactError instanceof Error ? compactError.message : "AI compaction failed");
      return false;
    }
  };

  const retryUserMessage = async (
    messageId: string,
    input: {
      content?: AiUserContentPart[];
      mode?: "retry" | "details" | "concise";
      modelProfileId?: string;
    } = {},
  ) => {
    const conversationId = activeConversationId();
    if (!conversationId) return false;
    const status = runStatus();
    if (status === "streaming" || status === "stopping") {
      setConversationError(conversationId, "Stop the current response before trying a message again.");
      return false;
    }
    setRunStatusRaw("streaming");
    clearErrors();
    try {
      const result = await request<SubmitTurnResult>(
        `/conversations/${conversationId}/messages/${messageId}/retry`,
        {
          method: "POST",
          body: JSON.stringify({
            mode: input.mode ?? "retry",
            content: input.content,
            modelProfileId: input.modelProfileId,
          }),
        },
        "AI retry failed",
      );
      if (invalidateInactiveCache(conversationId)) return true;
      // Truncate the client view to before the retried message, then show the new one.
      setState("messages", (prev) => [...prev.filter((message) => message.seq < result.message.seq), result.message]);
      cache.set(conversationId, { conversation: state.conversation, messages: state.messages, activeTurn: state.activeTurn });
      void refreshTimeline(conversationId);
      return true;
    } catch (retryError) {
      if (invalidateInactiveCache(conversationId)) return false;
      setRunStatusRaw("failed");
      setConversationError(conversationId, retryError instanceof Error ? retryError.message : "AI retry failed");
      return false;
    }
  };

  const forkMessage = async (messageId: string, input: { title?: string } = {}) => {
    const conversationId = activeConversationId();
    if (!conversationId) return null;
    const generation = ++conversationOpenGeneration;
    clearErrors();
    try {
      const detail = await request<AiConversationDetail>(
        `/conversations/${conversationId}/messages/${messageId}/fork`,
        { method: "POST", body: JSON.stringify(input) },
        "Failed to fork conversation",
      );
      const projection = detailToProjection(detail);
      cache.set(detail.conversation.id, projection);
      setHasMore(detail.conversation.id, detail.hasMoreMessages ?? false);
      if (detail.timeline) setTimeline(detail.conversation.id, detail.timeline);
      if (!isActiveConversation(conversationId) || generation !== conversationOpenGeneration) return detail.conversation;
      setState(reconcile(projection, { key: "id", merge: true }));
      setRunError(conversationRunError(detail.conversation));
      setActiveConversationIdSignal(detail.conversation.id);
      setLoadingConversationId(null);
      openStream(detail.conversation.id);
      return detail.conversation;
    } catch (forkError) {
      setConversationError(conversationId, forkError instanceof Error ? forkError.message : "Failed to fork conversation");
      return null;
    }
  };

  const updateMessageFeedback = (conversationId: string, messageId: string, feedback: AiMessageFeedback | null) => {
    if (!isActiveConversation(conversationId)) {
      const projection = cache.get(conversationId);
      if (projection)
        cache.set(conversationId, {
          ...projection,
          messages: projection.messages.map((message) =>
            message.id === messageId || message.shortId === messageId ? { ...message, feedback } : message,
          ),
        });
      return;
    }
    const index = state.messages.findIndex((message) => message.id === messageId || message.shortId === messageId);
    if (index < 0) return;
    setState("messages", index, "feedback", feedback);
    cache.set(conversationId, { conversation: state.conversation, messages: state.messages, activeTurn: state.activeTurn });
  };

  const setMessageFeedback = async (messageId: string, feedback: Omit<AiMessageFeedback, "updatedAt">) => {
    const conversationId = activeConversationId();
    if (!conversationId) return false;
    clearErrors();
    try {
      const result = await request<{ feedback: AiMessageFeedback }>(
        `/conversations/${conversationId}/messages/${messageId}/feedback`,
        { method: "PUT", body: JSON.stringify(feedback) },
        "Could not save message feedback",
      );
      updateMessageFeedback(conversationId, messageId, result.feedback);
      return true;
    } catch (feedbackError) {
      setConversationError(conversationId, feedbackError instanceof Error ? feedbackError.message : "Could not save message feedback");
      return false;
    }
  };

  const clearMessageFeedback = async (messageId: string) => {
    const conversationId = activeConversationId();
    if (!conversationId) return false;
    clearErrors();
    try {
      await request(
        `/conversations/${conversationId}/messages/${messageId}/feedback`,
        { method: "DELETE" },
        "Could not remove message feedback",
      );
      updateMessageFeedback(conversationId, messageId, null);
      return true;
    } catch (feedbackError) {
      setConversationError(conversationId, feedbackError instanceof Error ? feedbackError.message : "Could not remove message feedback");
      return false;
    }
  };

  const submitTurnActionForConversation = async (
    conversationId: string,
    turnId: string,
    callId: string,
    action: { type: "approval_response"; approved: boolean; remember?: "always" } | { type: "tool_result"; result: unknown },
  ) => {
    if (isActiveConversation(conversationId) && runStatus() === "stopping") return false;
    try {
      await request(
        `/conversations/${conversationId}/turns/${turnId}/actions/${callId}`,
        { method: "POST", body: JSON.stringify(action) },
        "Failed to continue AI turn",
      );
      return true;
    } catch (actionError) {
      setConversationError(conversationId, actionError instanceof Error ? actionError.message : "Failed to continue AI turn");
      return false;
    }
  };

  const submitTurnAction = (
    turnId: string,
    callId: string,
    action: { type: "approval_response"; approved: boolean; remember?: "always" } | { type: "tool_result"; result: unknown },
  ) => {
    const conversationId = activeConversationId();
    if (!conversationId) return Promise.resolve(false);
    clearErrors();
    return submitTurnActionForConversation(conversationId, turnId, callId, action);
  };

  const respondToApproval = async (request: { turnId: string; callId: string }, input: { approved: boolean; remember?: "always" }) => {
    const conversationId = activeConversationId();
    if (!conversationId) return false;
    const submitted = await submitTurnAction(request.turnId, request.callId, {
      type: "approval_response",
      approved: input.approved,
      remember: input.remember,
    });
    if (!submitted || !isActiveConversation(conversationId) || state.activeTurn?.turnId !== request.turnId) return submitted;
    const action = { type: "approval_response" as const, callId: request.callId, approved: input.approved };
    setState("activeTurn", (current) => {
      if (!current || current.turnId !== request.turnId) return current;
      const pending = current.blocks.some(
        (block) => block.kind === "tool" && block.callId === request.callId && block.status === "awaiting_approval",
      );
      if (!pending) return current;
      return reconcileActiveTurnActions(current, [{ callId: request.callId, resolvedEvent: action }]);
    });
    cache.set(conversationId, { conversation: state.conversation, messages: state.messages, activeTurn: state.activeTurn });
    return true;
  };

  const submitFrontendToolResult = async (request: { turnId: string; callId: string }, result: unknown) => {
    const conversationId = activeConversationId();
    if (!conversationId) return false;
    clearErrors();
    const submitted = await submitTurnActionForConversation(conversationId, request.turnId, request.callId, {
      type: "tool_result",
      result,
    });
    if (!submitted || !isActiveConversation(conversationId) || state.activeTurn?.turnId !== request.turnId) return submitted;
    const action = { type: "tool_result" as const, callId: request.callId, result };
    setState("activeTurn", (current) => {
      if (!current || current.turnId !== request.turnId) return current;
      const pending = current.blocks.some(
        (block) => block.kind === "tool" && block.callId === request.callId && block.status === "awaiting_client",
      );
      if (!pending) return current;
      return reconcileActiveTurnActions(current, [{ callId: request.callId, resolvedEvent: action }]);
    });
    cache.set(conversationId, { conversation: state.conversation, messages: state.messages, activeTurn: state.activeTurn });
    return true;
  };

  if (options.initialConversationId) {
    if (options.initialDetail) setHasMore(options.initialConversationId, options.initialDetail.hasMoreMessages ?? false);
    openStream(options.initialConversationId);
    void markConversationViewed(options.initialConversationId);
    runFrontendTools();
  }

  onCleanup(() => closeStream());

  const hasMoreHistory = () => {
    const conversationId = activeConversationId();
    return conversationId ? (hasMoreByConversation()[conversationId] ?? false) : false;
  };

  return {
    activeConversationId,
    conversation: () => state.conversation,
    setActiveConversationId,
    messages,
    activeTurn,
    hasMoreHistory,
    loadingOlder: () => isActiveConversationLoading(activeConversationId(), loadingOlderConversationId()),
    loadingConversation: () => isActiveConversationLoading(activeConversationId(), loadingConversationId()),
    loadOlderMessages,
    loadHistoryThroughSeq,
    timeline,
    timelineLoading: () => isActiveConversationLoading(activeConversationId(), loadingTimelineConversationId()),
    refreshTimeline,
    runStatus,
    running,
    streamStatus,
    error,
    setError: setActiveError,
    openConversation,
    refreshActiveConversation,
    createConversation,
    saveDraft,
    send,
    steer,
    retrySteer,
    abort,
    compactConversation,
    retryUserMessage,
    forkMessage,
    setMessageFeedback,
    clearMessageFeedback,
    submitTurnAction,
    respondToApproval,
    submitFrontendToolResult,
    fileContentUrl,
  };
};

export type AiChatController = ReturnType<typeof createAiChatController>;

const isComposerDraftSendable = (input: ComposerDraftInput): boolean =>
  Boolean(input.message?.trim() || input.content?.length || input.files?.length || input.resources?.length || input.storedFiles?.length);

export const __aiControllerTest = {
  claimFrontendCall,
  completeFrontendToolBlock,
  conversationRunError,
  failSteerBlock,
  projectionForConversationOpen,
  reconcileSteerBlocks,
  runErrorFromEvent,
  isCurrentStreamSession,
  isActiveConversationLoading,
  settleFrontendCall,
  isComposerDraftSendable,
};
