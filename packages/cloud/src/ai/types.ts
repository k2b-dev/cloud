import type {
  ContentPart,
  DoneReason,
  InboundEvent,
  Input,
  LoopAggregate,
  Message,
  Provider,
  SessionStore,
  Tool,
  ToolContext,
} from "@k2b/nessi";
import type { Usage } from "@k2b/nessi/ai";
import type { z } from "zod";
import type { CapabilityActionReview, CloudResourceRef } from "../contracts/capabilities";
import type { RequestActor } from "../server";
import type { AiTurnBlock } from "./protocol";

export const AI_MODEL_CAPABILITIES = ["streaming", "tools", "vision"] as const;
export type AiModelCapability = (typeof AI_MODEL_CAPABILITIES)[number];

export const AI_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"] as const;
export type AiImageMediaType = (typeof AI_IMAGE_MEDIA_TYPES)[number];
export const isAiImageMediaType = (value: string): value is AiImageMediaType =>
  AI_IMAGE_MEDIA_TYPES.some((mediaType) => mediaType === value);

export type AiProviderId = "openai" | "openrouter" | "anthropic" | "mistral" | "gemini" | "ollama" | "vllm" | "openai-compatible";

export const AI_DATA_BOUNDARIES = ["hosted", "private"] as const;
export type AiDataBoundary = (typeof AI_DATA_BOUNDARIES)[number];
/** @deprecated Use AiDataBoundary. */
export type AiDataPolicy = AiDataBoundary;

export type AiModelProfile = {
  id: string;
  label: string;
  provider: AiProviderId;
  model: string;
  enabled: boolean;
  /** Small logo (data URL, hard-compressed) shown in the admin card and the composer model picker. */
  image?: string;
  capabilities: AiModelCapability[];
  dataBoundary: AiDataBoundary;
  baseURL?: string;
  contextWindow?: number;
  temperature?: number;
  maxOutputTokens?: number;
  /** Maximum deferred tools retained per conversation. Missing or <= 0 keeps all loaded tools. */
  maxLoadedTools?: number;
  /** Tool-using model rounds per chat turn. Missing or <= 0 is unlimited. */
  maxToolRounds?: number;
  creditsPerInputToken?: number;
  creditsPerOutputToken?: number;
};

export type AiPublicModelProfile = Pick<
  AiModelProfile,
  "id" | "label" | "provider" | "model" | "image" | "capabilities" | "dataBoundary" | "contextWindow"
>;

export type AiUserContentPart = ContentPart;

export type AiSettingsErrorCode =
  | "ai_disabled"
  | "invalid_model_profiles"
  | "missing_default_model"
  | "default_model_disabled"
  | "missing_provider_credential"
  | "model_policy_mismatch";

export type AiSettingsError = {
  code: AiSettingsErrorCode;
  message: string;
  fields?: Record<string, string>;
};

export type AiSettingsState =
  | {
      ok: true;
      enabled: boolean;
      defaultModelId: string;
      visionModelId?: string;
      globalInstructions: string;
      compactionInstructions: string;
      maxToolResultChars: number;
      firecrawlConfigured: boolean;
      profiles: AiModelProfile[];
    }
  | {
      ok: false;
      enabled: boolean;
      defaultModelId: string;
      visionModelId?: string;
      globalInstructions: string;
      compactionInstructions: string;
      maxToolResultChars: number;
      firecrawlConfigured: boolean;
      profiles: AiModelProfile[];
      error: AiSettingsError;
    };

export type AiModelPolicy =
  | { kind: "platform-default"; allowedDataBoundaries?: AiDataBoundary[]; requiredCapabilities?: AiModelCapability[] }
  | { kind: "locked"; modelId: string; allowedDataBoundaries?: AiDataBoundary[]; requiredCapabilities?: AiModelCapability[] }
  | {
      kind: "selectable";
      defaultModelId?: string;
      allowedModelIds?: string[];
      allowedDataBoundaries?: AiDataBoundary[];
      requiredCapabilities?: AiModelCapability[];
    };

export type AiResolvedModel = {
  profile: AiModelProfile;
  provider: Provider;
};

export type AiDraftContentPart =
  | { type: "text"; text: string }
  | { type: "resource"; ref: CloudResourceRef; title?: string; icon?: string; href?: string }
  | { type: "file"; path: string; mediaType: string; size: number; version: number };

export type AiConversationDraft = {
  content: AiDraftContentPart[];
  revision: number;
  updatedAt: string | null;
};

export type AiConversationFieldSource = "default" | "auto" | "user";
export type AiConversationTitleSource = AiConversationFieldSource;
export type AiConversationRunStatus = "idle" | "queued" | "running" | "needs_attention" | "failed";
export type AiConversationStatusFilter = Exclude<AiConversationRunStatus, "idle" | "queued"> | "unread";

export type AiConversation = {
  id: string;
  shortId: string;
  title: string;
  /** Who set the current title — enrichment never overwrites a user-chosen title. */
  titleSource: AiConversationFieldSource;
  /** User-visible description. Kept fresh by the enrichment job until the user edits it. */
  description: string;
  /** Who wrote the current description — enrichment never overwrites a user-authored one. */
  descriptionSource: AiConversationFieldSource;
  /** AI-generated keywords for search. */
  keywords: string[];
  pinnedAt: string | null;
  archivedAt: string | null;
  runStatus: AiConversationRunStatus;
  /** Error from the latest turn when `runStatus` is `failed`. */
  runError: string | null;
  unreadCompletion: boolean;
  /** Optional shared project context; the conversation itself remains private to its owner. */
  projectId: string | null;
  /** Mutable pending user message. It is not part of model context until a turn consumes it. */
  draft: AiConversationDraft;
  createdByUserId: string | null;
  /** Application that explicitly launched this chat through `launchAssistant`; null for direct Assistant chats. */
  launchedByAppId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export const AI_MESSAGE_FEEDBACK_REASONS = [
  "incorrect",
  "did_not_follow_request",
  "incomplete",
  "poor_tool_choice",
  "too_slow",
  "other",
] as const;
export type AiMessageFeedbackReason = (typeof AI_MESSAGE_FEEDBACK_REASONS)[number];

export type AiMessageFeedback = {
  rating: "up" | "down";
  reasons: AiMessageFeedbackReason[];
  comment: string | null;
  updatedAt: string;
};

export type AiEnrichmentRunStatus = "ok" | "failed" | "skipped";
export type AiEnrichmentTrigger = "scheduled" | "manual";

/** One recorded enrichment attempt for a conversation — user-visible in chat settings. */
export type AiEnrichmentRun = {
  id: string;
  conversationId: string;
  status: AiEnrichmentRunStatus;
  trigger: AiEnrichmentTrigger;
  modelProfileId: string | null;
  /** nessi structured mode of the successful call: native | fallback | repair. */
  mode: string | null;
  durationMs: number | null;
  titleUpdated: boolean;
  keywordsCount: number;
  error: string | null;
  createdAt: string;
};

/** Current index state of one conversation, for the chat settings UI. */
export type AiEnrichmentStatus = {
  enrichedAt: string | null;
  /** Content changed since the last enrichment (or never enriched). */
  dirty: boolean;
  enrichFailCount: number;
  /** Current AI-generated search keywords. */
  keywords: string[];
};

export type AiEnrichmentOverviewRun = AiEnrichmentRun & {
  conversationTitle: string;
};

export type AiEnrichmentOverview = {
  totalConversations: number;
  dirtyConversations: number;
  failedConversations: number;
  oldestDirtyAt: string | null;
  lastRunAt: string | null;
  avgDurationMs: number | null;
  failedRuns24h: number;
  totalRuns24h: number;
  errorRate24h: number;
  recentRuns: AiEnrichmentOverviewRun[];
};

export type AiEnrichmentCandidate = AiConversation & {
  /**
   * The conversation's updated_at exactly as stored (Postgres microsecond
   * precision, via ::text). Written back as enriched_at — the ISO `updatedAt`
   * field is millisecond-truncated and would leave the chat dirty forever.
   */
  dirtyAsOf: string;
  /** Consecutive failed enrichment attempts (drives the retry backoff). */
  enrichFailCount: number;
};

export type AiConversationPage = {
  items: AiConversation[];
  total: number;
  page: number;
  perPage: number;
  hasNext: boolean;
};

export type AiConversationProjectUpdateResult =
  | { ok: true; conversation: AiConversation }
  | { ok: false; reason: "not_found" | "active_turn" };

export type AiStoredMessage = {
  id: string;
  shortId: string;
  conversationId: string;
  seq: number;
  kind: "message" | "summary";
  message: Message;
  loopId: string | null;
  modelProfileId: string | null;
  providerModel: string | null;
  usage: Usage | null;
  stopReason: string | null;
  loopAggregate: LoopAggregate | null;
  loopDoneReason: DoneReason | null;
  /**
   * Set once compaction archived this message out of the model context.
   * Archived messages stay visible in the chat; only the model stops seeing them.
   */
  compactedAt: string | null;
  /** UI metadata (e.g. how many messages a compaction summary replaced). */
  meta: {
    compactedCount?: number;
    steerId?: string;
    agentMessage?: {
      id: string;
      sourceChatId: string;
      sourceTurnId: string;
      sourceTitle: string;
      sourceHref?: string;
    };
    scheduledTask?: {
      taskId: string;
      occurrenceId: string;
      scheduledFor: string;
      trigger: "scheduled" | "manual";
    };
    toolPresentations?: Record<string, AiToolPresentation>;
    toolOutcomes?: Record<string, "rejected">;
  } | null;
  /** Private owner feedback for this rendered assistant response. Never enters model context. */
  feedback?: AiMessageFeedback | null;
  createdAt: string;
};

/** Lightweight navigation anchor for one user message in a long conversation. */
export type AiConversationTimelineEntry = {
  id: string;
  seq: number;
  loopId: string | null;
  userPreview: string;
  assistantPreview: string;
  isSteer: boolean;
  inputFileCount: number;
  outputFileCount: number;
  toolCount: number;
  createdAt: string;
};

export type AiTurnStatus = "queued" | "running" | "waiting_for_action" | "completed" | "failed" | "aborted";

export type AiTurnSteerStatus = "pending" | "consumed" | "discarded";

export type AiTurnSteer = {
  id: string;
  conversationId: string;
  turnId: string;
  seq: number;
  clientRequestId: string;
  text: string;
  status: AiTurnSteerStatus;
  messageId: string | null;
  createdAt: string;
  consumedAt: string | null;
};

export type AiTurnSteerEnqueueResult = { ok: true; steer: AiTurnSteer } | { ok: false; reason: "not_found" | "not_chat" | "not_active" };

export type AiTurnCompletionResult = "completed" | "pending_steering" | "lost";

export type AiTurnFinalizedEvent = {
  conversationId: string;
  turnId: string;
  status: "completed" | "failed" | "aborted";
  kind: AiTurnRunConfig["kind"] | null;
};

export type AiTurn = {
  id: string;
  shortId: string;
  conversationId: string;
  status: AiTurnStatus;
  attempt: number;
  modelProfileId: string | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
};

export type AiInterChatMessage = {
  id: string;
  shortId: string;
  sourceConversationId: string;
  sourceChatId: string;
  sourceTitle: string;
  sourceTurnId: string;
  sourceTurnShortId: string;
  sourceCallId: string;
  targetConversationId: string;
  targetChatId: string;
  targetTitle: string;
  actorUserId: string;
  text: string;
  status: "pending" | "delivered" | "failed";
  targetTurnId: string | null;
  targetTurnShortId: string | null;
  targetMessageId: string | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
};

export type AiPendingTurnAction =
  | {
      type: "approval_request";
      turnId: string;
      conversationId: string;
      callId: string;
      name: string;
      args: unknown;
      message?: string;
      review?: CapabilityActionReview;
      allowAlways: boolean;
    }
  | {
      type: "frontend_tool";
      turnId: string;
      conversationId: string;
      callId: string;
      name: string;
      args: unknown;
      mode: AiFrontendToolMode;
    };

export type AiTurnAbortRequest =
  | { found: false }
  | {
      found: true;
      status: AiTurnStatus;
      /** True when no live lease exists — the caller must finalize the turn itself. */
      ownerless: boolean;
    };

export type AiPendingTurnActionRecord = {
  turnId: string;
  conversationId: string;
  callId: string;
  kind: "approval" | "custom_approval" | "client_tool";
  status: "pending" | "resolved" | "aborted";
  name: string;
  args: unknown;
  message?: string;
  review?: CapabilityActionReview;
  approvalScope: string;
  allowAlways: boolean;
  frontendMode?: AiFrontendToolMode;
  resolvedEvent: InboundEvent | null;
};

export type AiTurnToolSource = { kind: "none" } | { kind: "default"; appTools?: boolean };

export type AiClientToolId = "local_bash";

/** Immutable project instructions and context manifest captured for one turn. */
export type AiProjectPromptSnapshot = {
  /** Public readable Project ID. Resolve it once before using internal Project services. */
  id: string;
  name: string;
  revision: number;
  instructions: string;
  context: string;
  references: CloudResourceRef[];
  defaultModelProfileId: string | null;
};

export type AiProjectFileToolStat = {
  path: string;
  mediaType: string;
  size: number;
  updatedAt: string;
};

export type AiProjectFileToolContent = AiProjectFileToolStat & { bytes: Uint8Array };

/** Current-authority, read-only Project file access mounted into AI file tools. */
export type AiProjectFileToolSource = {
  list: () => Promise<AiProjectFileToolStat[]>;
  read: (path: string) => Promise<AiProjectFileToolContent | null>;
};

export type AiSkillFileToolStat = {
  path: string;
  mediaType: string;
  size: number;
  updatedAt: string;
};

export type AiSkillFileToolContent = AiSkillFileToolStat & { bytes: Uint8Array };

/** Permission-checked, immutable loaded-skill snapshots mounted below /skills. */
export type AiSkillFileToolSource = {
  list: () => Promise<AiSkillFileToolStat[]>;
  read: (path: string) => Promise<AiSkillFileToolContent | null>;
};

export type AiConversationResourceRef = {
  ref: CloudResourceRef;
  title: string | null;
  preview: string | null;
  icon: string | null;
  href: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  sourceTurnId: string | null;
  sourceCallId: string | null;
};

export type AiConversationResourceObservation = {
  ref: CloudResourceRef;
  title?: string;
  preview?: string;
  icon?: string;
  href?: string;
};

export type AiConversationResourceOccurrence = AiConversationResourceRef & {
  chat: Pick<AiConversation, "shortId" | "title" | "updatedAt">;
};

export type AiConversationSourceKind = "web" | "file" | "resource" | "activity";

export type AiConversationSource = {
  kind: AiConversationSourceKind;
  key: string;
  title: string;
  preview: string | null;
  icon: string;
  href: string | null;
  path: string | null;
  mediaType: string | null;
  size: number | null;
  ref: CloudResourceRef | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sourceTurnId: string | null;
  sourceCallId: string | null;
};

export type AiConversationSourceObservation = {
  kind: "web" | "activity";
  key: string;
  title: string;
  preview?: string;
  icon?: string;
  href?: string;
};

export type AiConversationFileSnapshotEntry = {
  path: string;
  size: number;
  mediaType: string;
  origin: "user" | "assistant";
  updatedAt: string;
  version?: number;
};

export type AiConversationFileSnapshot = {
  attached: AiConversationFileSnapshotEntry[];
  available: AiConversationFileSnapshotEntry[];
  total: number;
};

export type AiChatTurnRunConfig = {
  kind?: "chat";
  input: Input;
  /** Stable public ID exposed as runtime context, not instructions. */
  chatId?: string;
  actor?: RequestActor;
  /** Request locale persisted with the turn so async execution keeps the caller preference. */
  locale?: string;
  modelPolicy?: AiModelPolicy;
  requestedModelId?: string;
  /** Optional instructions that apply only to this turn. */
  systemPrompt?: string;
  project?: AiProjectPromptSnapshot;
  files?: AiConversationFileSnapshot;
  /** Whether this turn's materialized tools can inspect referenced images. */
  canInspectAttachedImages?: boolean;
  clientToolIds?: AiClientToolId[];
  toolSource?: AiTurnToolSource;
  toolApprovalContext?: {
    actorUserId: string;
  };
};

export type AiCompactionTurnRunConfig = {
  kind: "compact";
  actor?: RequestActor;
  modelPolicy?: AiModelPolicy;
  requestedModelId?: string;
};

export type AiTurnRunConfig = AiChatTurnRunConfig | AiCompactionTurnRunConfig;

export type AiTurnClaim = {
  turn: AiTurn;
  runConfig: AiTurnRunConfig | null;
  /** Live blocks persisted by a previous attempt (continuation base), if any. */
  liveBlocks: AiTurnBlock[] | null;
  /** Highest wire seq of the previous attempt; the new attempt continues from here. */
  liveSeq: number;
};

export type AiTurnSweepAction = { conversationId: string; turnId: string };
/** A turn finalized by the sweep, with the wire coordinates for its turn_finished event. */
export type AiTurnFinalizedAction = AiTurnSweepAction & { attempt: number; seq: number };

export type AiTurnSweepResult = {
  /** Lease-expired or stale-queued turns that need (re-)enqueueing. */
  requeued: AiTurnSweepAction[];
  /** Turns finalized as failed (deadline exceeded); turn_finished must be published. */
  failed: (AiTurnFinalizedAction & { error: string })[];
  /** Turns finalized as aborted (cancel requested or waiting deadline); turn_finished must be published. */
  aborted: AiTurnFinalizedAction[];
};

export type AiConversationService = {
  createConversation(input: {
    ownerUserId: string;
    title?: string;
    description?: string;
    projectId?: string;
    draft?: AiDraftContentPart[];
    preloadTools?: string[];
    launchedByAppId?: string;
  }): Promise<AiConversation>;
  forkConversation(input: {
    sourceConversationId: string;
    throughSeq: number;
    ownerUserId: string;
    title?: string;
  }): Promise<AiConversation>;
  listConversations(input: {
    ownerUserId: string;
    search?: string;
    refs?: CloudResourceRef[];
    archived?: boolean;
    status?: AiConversationStatusFilter;
    projectId?: string;
    unassigned?: boolean;
    limit?: number;
  }): Promise<AiConversation[]>;
  listSidebarConversations(input: { ownerUserId: string; unassignedLimit?: number; perProjectLimit?: number }): Promise<AiConversation[]>;
  listConversationsPage(input: {
    ownerUserId: string;
    search?: string;
    archived?: boolean;
    status?: AiConversationStatusFilter;
    projectId?: string;
    unassigned?: boolean;
    page: number;
    perPage: number;
  }): Promise<AiConversationPage>;
  getConversation(input: { conversationId: string; ownerUserId?: string }): Promise<AiConversation | null>;
  getConversationByShortId(input: { shortId: string; ownerUserId?: string; archived?: boolean }): Promise<AiConversation | null>;
  saveDraft(input: {
    conversationId: string;
    ownerUserId: string;
    expectedRevision: number;
    content: AiDraftContentPart[];
  }): Promise<{ ok: true; draft: AiConversationDraft } | { ok: false; reason: "not_found" | "conflict" }>;
  getLoadedTools(input: { conversationId: string }): Promise<string[]>;
  loadTools(input: {
    conversationId: string;
    names: string[];
    maxLoadedTools?: number;
  }): Promise<{ loaded: string[]; alreadyLoaded: string[]; evicted: string[] }>;
  indexConversationResources(input: {
    conversationId: string;
    turnId?: string;
    callId?: string;
    resources: AiConversationResourceObservation[];
  }): Promise<void>;
  listConversationResources(input: {
    conversationId: string;
    search?: string;
    before?: string;
    limit?: number;
  }): Promise<{ resources: AiConversationResourceRef[]; nextCursor?: string }>;
  listUserConversationResources(input: {
    ownerUserId: string;
    search?: string;
    before?: string;
    limit?: number;
  }): Promise<{ resources: AiConversationResourceOccurrence[]; nextCursor?: string }>;
  indexConversationSource(input: {
    conversationId: string;
    turnId?: string;
    callId?: string;
    source: AiConversationSourceObservation;
  }): Promise<void>;
  listConversationSources(input: {
    conversationId: string;
    search?: string;
    before?: string;
    limit?: number;
  }): Promise<{ sources: AiConversationSource[]; nextCursor?: string }>;
  getCapabilityInvocationOrigin(input: { idempotencyKey: string; toolName: string }): Promise<{
    conversationId: string;
    conversationShortId: string;
    turnId: string;
    turnShortId: string;
    callId: string;
  } | null>;
  createInterChatMessage(input: {
    sourceConversationId: string;
    sourceTurnId: string;
    sourceCallId: string;
    targetChatId: string;
    actorUserId: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ ok: true; message: AiInterChatMessage } | { ok: false; reason: "not_found" | "same_chat" | "recursive" }>;
  listPendingInterChatMessages(input?: { targetConversationId?: string; limit?: number }): Promise<AiInterChatMessage[]>;
  failInterChatMessage(input: { messageId: string; error: string }): Promise<boolean>;
  deliverInterChatMessage(input: {
    messageId: string;
    modelProfileId: string;
    runConfig: AiChatTurnRunConfig;
    userMessage: Message;
    sourceHref?: string;
  }): Promise<
    { delivered: false; reason: "not_found" | "busy" | "failed" } | { delivered: true; message: AiInterChatMessage; turn: AiTurn }
  >;
  updateConversationMetadata(input: {
    conversationId: string;
    ownerUserId?: string;
    title: string;
    description?: string;
    pinned?: boolean;
  }): Promise<AiConversation | null>;
  setConversationProject(input: {
    conversationId: string;
    ownerUserId?: string;
    projectId: string | null;
  }): Promise<AiConversationProjectUpdateResult>;
  setConversationPinned(input: { conversationId: string; ownerUserId?: string; pinned: boolean }): Promise<AiConversation | null>;
  archiveConversation(input: { conversationId: string; ownerUserId?: string }): Promise<boolean>;
  restoreConversation(input: { conversationId: string; ownerUserId?: string }): Promise<AiConversation | null>;
  markConversationViewed(input: { conversationId: string; ownerUserId?: string }): Promise<boolean>;
  /**
   * Conversations whose content changed since the last enrichment (no active
   * turn, has messages, failure backoff elapsed). Oldest first. With
   * `conversationId` (manual reindex) the dirty and backoff checks are skipped.
   */
  listEnrichmentCandidates(input: { limit: number; conversationId?: string }): Promise<AiEnrichmentCandidate[]>;
  /**
   * Store enrichment results and clear the failure backoff. `dirtyAsOf` is the
   * candidate's exact scan-time updated_at (microsecond precision) — enriched_at
   * is set to it, so activity during the run keeps the chat dirty while an
   * unchanged chat becomes exactly clean (updated_at = enriched_at).
   * `description`/`title` are omitted when the current value is user-authored.
   */
  applyEnrichment(input: {
    conversationId: string;
    /** Internal rolling search projection; never replaces the user-visible description. */
    searchSummary: string;
    description?: string;
    keywords: string[];
    title?: string;
    dirtyAsOf: string;
  }): Promise<void>;
  /** Record a failed enrichment attempt — the candidate query backs the chat off exponentially. */
  markEnrichmentFailed(input: { conversationId: string }): Promise<void>;
  /** Append one run to the user-visible enrichment history (keeps the newest 20 per conversation). */
  recordEnrichmentRun(input: {
    conversationId: string;
    status: AiEnrichmentRunStatus;
    trigger: AiEnrichmentTrigger;
    modelProfileId?: string;
    mode?: string;
    durationMs?: number;
    titleUpdated?: boolean;
    keywordsCount?: number;
    error?: string;
  }): Promise<void>;
  listEnrichmentRuns(input: { conversationId: string; limit?: number }): Promise<AiEnrichmentRun[]>;
  getEnrichmentStatus(input: { conversationId: string }): Promise<AiEnrichmentStatus | null>;
  getEnrichmentOverview(): Promise<AiEnrichmentOverview>;
  /** Chat history for humans: includes compacted messages, hides superseded summaries. */
  listMessages(input: { conversationId: string }): Promise<AiStoredMessage[]>;
  /**
   * Newest window of the human view for infinite scroll. `beforeSeq` pages
   * older history (exclusive). Whole seq groups are always returned together
   * (compaction can put several rows on one seq), so the cursor
   * `min(seq) of the page` never skips rows.
   */
  listMessagesPage(input: { conversationId: string; beforeSeq?: number; limit?: number }): Promise<{
    messages: AiStoredMessage[];
    hasMore: boolean;
  }>;
  searchConversationMessages(input: {
    conversationId: string;
    query: string;
    beforeSeq?: number;
    limit?: number;
  }): Promise<{ messages: AiStoredMessage[]; nextCursor?: string }>;
  /** Compact full-conversation index used by the long-chat turn navigator. */
  listConversationTimeline(input: { conversationId: string }): Promise<AiConversationTimelineEntry[]>;
  /** Model context: only active (non-compacted) messages — what the LLM sees. */
  listContextMessages(input: { conversationId: string }): Promise<AiStoredMessage[]>;
  copyMessages(input: { sourceConversationId: string; targetConversationId: string; throughSeq: number }): Promise<void>;
  truncateMessagesFrom(input: { conversationId: string; fromSeq: number }): Promise<void>;
  setLatestAssistantLoopAggregate(input: {
    conversationId: string;
    loopId?: string | null;
    aggregate: LoopAggregate;
    doneReason: DoneReason;
  }): Promise<void>;
  compactMessages(input: {
    conversationId: string;
    checkpointSeq: number;
    summary: Message;
    modelProfileId?: string | null;
  }): Promise<void>;
  listTurnMessages(input: { conversationId: string; loopId: string; includeCompacted?: boolean }): Promise<AiStoredMessage[]>;
  setMessageFeedback(input: {
    conversationId: string;
    messageShortId: string;
    feedback: Omit<AiMessageFeedback, "updatedAt">;
  }): Promise<AiMessageFeedback | null>;
  clearMessageFeedback(input: { conversationId: string; messageShortId: string }): Promise<boolean>;
  /** Create a queued compaction turn. Chat turns must use submitChatTurn. */
  createCompactionTurn(input: { conversationId: string; modelProfileId: string; runConfig: AiCompactionTurnRunConfig }): Promise<AiTurn>;
  /** Persist the user message and create its turn in one transaction. */
  submitChatTurn(input: {
    conversationId: string;
    modelProfileId: string;
    runConfig: AiChatTurnRunConfig;
    userMessage: Message;
    /** Atomically consume this saved draft revision when present. */
    expectedDraftRevision?: number;
    /** Conversation Project observed while resolving this turn's immutable snapshot. */
    expectedProjectId?: string | null;
    /** Delete active messages with seq >= truncateFromSeq first (retry-in-place). */
    truncateFromSeq?: number;
    /** Resources introduced by this user message, indexed in the same transaction. */
    resources?: AiConversationResourceObservation[];
    /** Retry source whose immutable turn-file bytes are copied into the new turn. */
    retrySourceTurnId?: string;
  }): Promise<{ turn: AiTurn; message: AiStoredMessage }>;
  getTurnRunConfig(input: { conversationId: string; turnId: string }): Promise<AiTurnRunConfig | null>;
  getTurn(input: { conversationId: string; turnId: string }): Promise<AiTurn | null>;
  getTurnByShortId(input: { conversationId: string; shortId: string }): Promise<AiTurn | null>;
  getActiveTurn(input: { conversationId: string }): Promise<{ turn: AiTurn; liveBlocks: AiTurnBlock[]; liveSeq: number } | null>;
  /**
   * Claim a turn attempt. Increments attempt and takes the lease atomically.
   * `from: "queue"` claims queued or lease-expired running turns; `from: "waiting"`
   * claims a suspended turn only when its currently awaiting action was resolved.
   * Normal action continuations do not consume the recovery-attempt budget.
   */
  claimTurn(input: {
    conversationId: string;
    turnId: string;
    leaseOwner: string;
    leaseMs: number;
    from: "queue" | "waiting";
    maxAttempts: number;
    runBudgetMs: number;
  }): Promise<AiTurnClaim | null>;
  heartbeatTurn(input: { conversationId: string; turnId: string; leaseOwner: string; leaseMs: number }): Promise<boolean>;
  /** Release the worker: persist live state, drop the lease, park the turn until its actions resolve. */
  suspendTurn(input: {
    conversationId: string;
    turnId: string;
    leaseOwner: string;
    blocks: AiTurnBlock[];
    seq: number;
    waitingBudgetMs: number;
  }): Promise<boolean>;
  saveTurnLiveState(input: {
    conversationId: string;
    turnId: string;
    leaseOwner: string;
    blocks: AiTurnBlock[];
    seq: number;
  }): Promise<boolean>;
  /** Record an abort wish. The caller finalizes ownerless turns itself. */
  requestTurnAbort(input: { conversationId: string; turnId: string; reason?: string }): Promise<AiTurnAbortRequest>;
  completeTurn(input: {
    conversationId: string;
    turnId: string;
    status: "completed" | "failed" | "aborted";
    error?: string | null;
    /** When set, only the lease owner may finalize; otherwise only ownerless turns are finalized. */
    leaseOwner?: string;
  }): Promise<AiTurnCompletionResult>;
  /** Periodic maintenance: requeue lost turns, fail exhausted/over-budget turns, abort stale waits. */
  sweepTurns(input?: { limit?: number; maxAttempts?: number }): Promise<AiTurnSweepResult>;
  savePendingTurnAction(input: AiPendingTurnActionRecord): Promise<void>;
  listPendingTurnActions(input: { conversationId: string; turnId: string }): Promise<AiPendingTurnAction[]>;
  getPendingTurnAction(input: { conversationId: string; turnId: string; callId: string }): Promise<AiPendingTurnActionRecord | null>;
  listPendingActionRecords(input: { conversationId: string; turnId: string }): Promise<AiPendingTurnActionRecord[]>;
  listResolvedPendingActions(input: { conversationId: string; turnId: string }): Promise<AiPendingTurnActionRecord[]>;
  resolvePendingTurnAction(input: {
    conversationId: string;
    turnId: string;
    callId: string;
    event: InboundEvent;
  }): Promise<AiPendingTurnActionRecord | null>;
  clearPendingTurnActions(input: { conversationId: string; turnId: string }): Promise<void>;
  enqueueTurnSteer(input: {
    conversationId: string;
    turnId: string;
    clientRequestId: string;
    text: string;
  }): Promise<AiTurnSteerEnqueueResult>;
  listTurnSteers(input: { conversationId: string; turnId: string }): Promise<AiTurnSteer[]>;
  /** Atomically make pending steers visible to the model and return them in order. */
  takePendingTurnSteers(input: { conversationId: string; turnId: string; leaseOwner: string }): Promise<AiTurnSteer[]>;
  createSessionStore(input: {
    conversationId: string;
    modelProfileId?: string | null;
    turnId?: string | null;
    leaseOwner?: string | null;
    /** Ephemeral provider input for this turn; user-message persistence remains reference-only. */
    turnInput?: Input;
    /** Mutable snapshot map read only when an assistant tool-call message is persisted. */
    toolPresentations?: ReadonlyMap<string, AiToolPresentation>;
    /** Mutable call-id set read only when a rejected tool result is persisted. */
    rejectedToolCallIds?: ReadonlySet<string>;
  }): SessionStore;
};

export type AiAccessResult<TAccess = unknown> = {
  allowed: boolean;
  data?: TAccess;
  reason?: string;
};

export type AiToolApprovalPolicy = "never" | "once" | "always" | { kind: "user-configurable"; default: "once" | "always"; scope?: string };

export type AiFrontendToolMode = "client" | "client_view" | "client_interaction";

export type AiCapabilityToolPresentation = {
  kind: "capability";
  appId: string;
  appName: string;
  appIcon: string;
  appAccent?: string;
  title: string;
  capabilityKind: "query" | "action";
};

export type AiToolPresentation = AiCapabilityToolPresentation;

export type AiToolDefinition<TInput extends z.ZodType = z.ZodType, TOutput extends z.ZodType = z.ZodType> = {
  name: string;
  /** Stable identity when the callable name is provider-encoded. */
  canonicalName?: string;
  description: string;
  inputSchema: TInput;
  outputSchema: TOutput;
  approval: AiToolApprovalPolicy;
  /** Per-tool execution timeout enforced by nessi. */
  timeoutMs?: number;
  /** One-line "when to use" hint listed in the system prompt's Tools section. Tools without a hint are not listed. */
  promptHint?: string;
  /** Optional compact representation sent to providers in later loops. The full result remains persisted and visible. */
  toHistoricalResult?: (context: { input: z.infer<TInput>; output: z.infer<TOutput>; callId: string }) => unknown | Promise<unknown>;
};

export type AiToolRuntime<TInput extends z.ZodType = z.ZodType, TOutput extends z.ZodType = z.ZodType> =
  | {
      location: "server";
      def: AiToolDefinition<TInput, TOutput>;
      run(
        input: z.infer<TInput>,
        ctx: ToolContext & {
          actor: RequestActor;
          conversationId?: string;
          turnId?: string;
          attachedFilePaths?: ReadonlySet<string>;
          allowedDataBoundaries?: AiDataBoundary[];
          projectFiles?: AiProjectFileToolSource;
          skillFiles?: AiSkillFileToolSource;
          selectedModel?: AiResolvedModel;
          locale?: string;
          timeZone?: string;
        },
      ): Promise<z.infer<TOutput>>;
    }
  | {
      location: AiFrontendToolMode;
      def: AiToolDefinition<TInput, TOutput>;
    };

export type AiRuntimeTool = Tool | AiToolRuntime;
