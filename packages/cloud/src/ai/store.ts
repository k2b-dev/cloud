import { parseAiTodoPlan } from "./todo-contracts";
import type { DoneReason, InboundEvent, LoopAggregate, Message, SessionStore, StoreEntry } from "@k2b/nessi";
import type { Usage } from "@k2b/nessi/ai";
import { sql, type SQL } from "bun";
import { type CapabilityActionReview, CapabilityActionReviewSchema } from "../contracts/capabilities";
import { logger } from "../services/logging";
import { toPgTextArray } from "../services/postgres";
import type { AiTurnBlock } from "./protocol";
import { withAiShortId, withAiShortIdForDb } from "./short-id";
import type {
  AiConversation,
  AiConversationDraft,
  AiConversationPage,
  AiConversationResourceOccurrence,
  AiConversationResourceRef,
  AiConversationService,
  AiConversationSource,
  AiConversationTimelineEntry,
  AiEnrichmentOverview,
  AiEnrichmentOverviewRun,
  AiEnrichmentRun,
  AiFrontendToolMode,
  AiInterChatMessage,
  AiPendingTurnAction,
  AiPendingTurnActionRecord,
  AiStoredMessage,
  AiToolPresentation,
  AiTurn,
  AiTurnClaim,
  AiTurnRunConfig,
  AiTurnStatus,
  AiTurnSteer,
  AiTurnSweepResult,
} from "./types";

/** A queued turn this old without a claim is considered lost and re-enqueued by the sweep. */
const SWEEP_STALE_QUEUED_MS = 15_000;
/** A queued turn this old that never started is failed outright. */
const SWEEP_DEAD_QUEUED_MS = 30 * 60_000;
const SEARCH_TEXT_MAX_CHARS = 50_000;
const CONVERSATION_BM25_INDEX = "ai.conversations_search_bm25_idx";
const MESSAGE_BM25_INDEX = "ai.messages_search_bm25_idx";
const SEARCH_CAPABILITY_ERROR_CODES = new Set(["0A000", "42704", "42883", "55000"]);
const log = logger("ai:conversation-search");

export const resolveAiTurnShortIds = async (input: {
  conversationId: string;
  turnIds: readonly string[];
}): Promise<Map<string, string>> => {
  const turnIds = [...new Set(input.turnIds.filter(Boolean))];
  if (turnIds.length === 0) return new Map();
  const rows = await sql<{ id: string; short_id: string }[]>`
    SELECT id::text AS id, short_id
    FROM ai.turns
    WHERE conversation_id = ${input.conversationId}::uuid
      AND id::text = ANY(${toPgTextArray(turnIds)}::text[])
  `;
  return new Map(rows.map((row) => [row.id, row.short_id]));
};

type ConversationSearchBackend = "native" | "bm25";
let conversationSearchBackendPromise: Promise<ConversationSearchBackend> | null = null;

const detectConversationSearchBackend = async (): Promise<ConversationSearchBackend> => {
  const [row] = await sql<{ available: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch')
      AND EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_am am ON am.oid = c.relam
        WHERE c.oid = to_regclass(${CONVERSATION_BM25_INDEX}) AND am.amname = 'bm25'
      )
      AND EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_am am ON am.oid = c.relam
        WHERE c.oid = to_regclass(${MESSAGE_BM25_INDEX}) AND am.amname = 'bm25'
      ) AS available
  `;
  return row?.available ? "bm25" : "native";
};

const getConversationSearchBackend = (): Promise<ConversationSearchBackend> => {
  conversationSearchBackendPromise ??= detectConversationSearchBackend().catch((error) => {
    log.warn("Conversation search backend detection failed; using native PostgreSQL FTS", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "native";
  });
  return conversationSearchBackendPromise;
};

const isSearchCapabilityError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && SEARCH_CAPABILITY_ERROR_CODES.has(String(error.code));

type ConversationRow = {
  activity?: AiConversation["activity"];
  id: string;
  short_id: string;
  title: string;
  title_source: string | null;
  description: string | null;
  description_source: string | null;
  keywords: string[] | null;
  pinned_at: Date | string | null;
  archived_at: Date | string | null;
  done: boolean | null;
  last_used_at: Date | string;
  is_done?: boolean;
  has_active_schedule?: boolean;
  background_received_at?: Date | string | null;
  last_viewed_at: Date | string | null;
  latest_turn_status?: AiTurnStatus | null;
  latest_browser_pending?: boolean;
  latest_turn_error?: string | null;
  latest_turn_completed_at?: Date | string | null;
  enrich_fail_count: number | null;
  project_id: string | null;
  draft_content: unknown;
  draft_revision: number | string;
  draft_updated_at: Date | string | null;
  created_by_user_id: string | null;
  launched_by_app_id: string | null;
  allowed_tools: string[] | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type CountRow = {
  total: number | string;
};

type EnrichmentRunRow = {
  id: string;
  conversation_id: string;
  conversation_title?: string;
  status: "ok" | "failed" | "skipped";
  trigger: "scheduled" | "manual";
  model_profile_id: string | null;
  mode: string | null;
  duration_ms: number | string | null;
  title_updated: boolean;
  keywords_count: number | string | null;
  error: string | null;
  created_at: Date | string;
};

type MessageRow = {
  id: string;
  short_id: string;
  conversation_id: string;
  seq: number;
  kind: "message" | "summary";
  message: unknown;
  loop_id: string | null;
  model_profile_id: string | null;
  provider_model: string | null;
  usage: unknown;
  stop_reason: string | null;
  loop_aggregate: unknown;
  loop_done_reason: DoneReason | null;
  compacted_at: Date | string | null;
  meta: unknown;
  feedback_rating: number | string | null;
  feedback_reasons: string[] | null;
  feedback_comment: string | null;
  feedback_updated_at: Date | string | null;
  created_at: Date | string;
};

type TurnRow = {
  deadline?: Date | string | null;
  run_budget_ms?: number | null;
  cancel_requested_at?: Date | string | null;
  id: string;
  short_id: string;
  conversation_id: string;
  status: AiTurnStatus;
  attempt: number;
  model_profile_id: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
  error: string | null;
  run_config?: unknown;
  live_blocks?: unknown;
  live_seq?: number | string;
  lease_owner?: string | null;
  lease_expires_at?: Date | string | null;
};

type PendingActionRow = {
  turn_id: string;
  conversation_id: string;
  call_id: string;
  kind: "approval" | "custom_approval" | "client_tool";
  status: "pending" | "resolved" | "aborted";
  tool_name: string;
  args: unknown;
  message: string | null;
  review: unknown | null;
  approval_scope: string;
  allow_always: boolean;
  frontend_mode: AiFrontendToolMode | null;
  resolved_event: unknown | null;
};

type TurnSteerRow = {
  id: string;
  conversation_id: string;
  turn_id: string;
  seq: number;
  client_request_id: string;
  text: string;
  status: "pending" | "consumed" | "discarded";
  message_id: string | null;
  created_at: Date | string;
  consumed_at: Date | string | null;
};

type ConversationResourceRefRow = {
  resource_type: string;
  resource_id: string;
  title: string | null;
  preview: string | null;
  icon: string | null;
  href: string | null;
  source_turn_id: string | null;
  source_call_id: string | null;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
};

type ConversationResourceOccurrenceRow = ConversationResourceRefRow & {
  conversation_short_id: string;
  conversation_title: string;
  conversation_updated_at: Date | string;
};

type ConversationSourceRow = {
  source_kind: AiConversationSource["kind"];
  source_key: string;
  title: string;
  preview: string | null;
  icon: string | null;
  href: string | null;
  path: string | null;
  media_type: string | null;
  size: number | string | null;
  resource_type: string | null;
  resource_id: string | null;
  occurrences: number | string;
  source_turn_id: string | null;
  source_call_id: string | null;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
};

type InterChatMessageRow = {
  id: string;
  short_id: string;
  source_conversation_id: string;
  source_chat_id: string;
  source_title: string;
  source_turn_id: string;
  source_turn_short_id: string;
  source_call_id: string;
  target_conversation_id: string;
  target_chat_id: string;
  target_title: string;
  actor_user_id: string;
  text: string;
  status: "pending" | "delivered" | "failed";
  target_turn_id: string | null;
  target_turn_short_id: string | null;
  target_message_id: string | null;
  error: string | null;
  created_at: Date | string;
  delivered_at: Date | string | null;
};

type TimelineRow = {
  id: string;
  seq: number;
  loop_id: string | null;
  user_preview: string | null;
  assistant_preview: string | null;
  is_steer: boolean;
  input_file_count: number | string | null;
  output_file_count: number | string | null;
  tool_count: number | string | null;
  created_at: Date | string;
};

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

const rowToConversationResourceRef = (row: ConversationResourceRefRow): AiConversationResourceRef => ({
  ref: { type: row.resource_type, id: row.resource_id },
  title: row.title,
  preview: row.preview,
  icon: row.icon,
  href: row.href,
  sourceTurnId: row.source_turn_id,
  sourceCallId: row.source_call_id,
  firstSeenAt: iso(row.first_seen_at),
  lastSeenAt: iso(row.last_seen_at),
});

type ResourceCursor = { at: string; type: string; id: string };
const encodeResourceCursor = (row: ConversationResourceRefRow): string =>
  encodeURIComponent(JSON.stringify({ at: iso(row.last_seen_at), type: row.resource_type, id: row.resource_id } satisfies ResourceCursor));
const encodeSourceCursor = (row: ConversationSourceRow): string =>
  encodeURIComponent(JSON.stringify({ at: iso(row.last_seen_at), type: row.source_kind, id: row.source_key } satisfies ResourceCursor));
const decodeResourceCursor = (value: string | undefined): ResourceCursor | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<ResourceCursor>;
    return typeof parsed.at === "string" &&
      !Number.isNaN(Date.parse(parsed.at)) &&
      typeof parsed.type === "string" &&
      typeof parsed.id === "string"
      ? { at: parsed.at, type: parsed.type, id: parsed.id }
      : null;
  } catch {
    return null;
  }
};

const rowToConversationResourceOccurrence = (row: ConversationResourceOccurrenceRow): AiConversationResourceOccurrence => ({
  ...rowToConversationResourceRef(row),
  chat: {
    shortId: row.conversation_short_id,
    title: row.conversation_title,
    updatedAt: iso(row.conversation_updated_at),
  },
});

const rowToConversationSource = (row: ConversationSourceRow): AiConversationSource => ({
  kind: row.source_kind,
  key: row.source_key,
  title: row.title,
  preview: row.preview,
  icon: row.icon || "ti ti-link",
  href: row.href,
  path: row.path,
  mediaType: row.media_type,
  size: row.size === null ? null : Number(row.size),
  ref: row.resource_type && row.resource_id ? { type: row.resource_type, id: row.resource_id } : null,
  occurrences: Number(row.occurrences),
  firstSeenAt: iso(row.first_seen_at),
  lastSeenAt: iso(row.last_seen_at),
  sourceTurnId: row.source_turn_id,
  sourceCallId: row.source_call_id,
});

const rowToInterChatMessage = (row: InterChatMessageRow): AiInterChatMessage => ({
  id: row.id,
  shortId: row.short_id,
  sourceConversationId: row.source_conversation_id,
  sourceChatId: row.source_chat_id,
  sourceTitle: row.source_title,
  sourceTurnId: row.source_turn_id,
  sourceTurnShortId: row.source_turn_short_id,
  sourceCallId: row.source_call_id,
  targetConversationId: row.target_conversation_id,
  targetChatId: row.target_chat_id,
  targetTitle: row.target_title,
  actorUserId: row.actor_user_id,
  text: row.text,
  status: row.status,
  targetTurnId: row.target_turn_id,
  targetTurnShortId: row.target_turn_short_id,
  targetMessageId: row.target_message_id,
  error: row.error,
  createdAt: iso(row.created_at),
  deliveredAt: row.delivered_at ? iso(row.delivered_at) : null,
});

const interChatMessageSelect = () => sql`
  SELECT message.id, message.short_id, message.source_conversation_id,
         source.short_id AS source_chat_id, source.title AS source_title,
         message.source_turn_id, source_turn.short_id AS source_turn_short_id, message.source_call_id,
         message.target_conversation_id, target.short_id AS target_chat_id, target.title AS target_title,
         message.actor_user_id, message.text, message.status, message.target_turn_id,
         target_turn.short_id AS target_turn_short_id, message.target_message_id, message.error,
         message.created_at, message.delivered_at
  FROM ai.inter_chat_messages message
  JOIN ai.conversations source ON source.id = message.source_conversation_id
  JOIN ai.turns source_turn ON source_turn.id = message.source_turn_id
  JOIN ai.conversations target ON target.id = message.target_conversation_id
  LEFT JOIN ai.turns target_turn ON target_turn.id = message.target_turn_id
`;

type ResourceOccurrenceCursor = ResourceCursor & { chat: string };
const encodeResourceOccurrenceCursor = (row: ConversationResourceOccurrenceRow): string =>
  encodeURIComponent(
    JSON.stringify({
      at: iso(row.last_seen_at),
      type: row.resource_type,
      id: row.resource_id,
      chat: row.conversation_short_id,
    } satisfies ResourceOccurrenceCursor),
  );
const decodeResourceOccurrenceCursor = (value: string | undefined): ResourceOccurrenceCursor | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<ResourceOccurrenceCursor>;
    return typeof parsed.at === "string" &&
      !Number.isNaN(Date.parse(parsed.at)) &&
      typeof parsed.type === "string" &&
      typeof parsed.id === "string" &&
      typeof parsed.chat === "string"
      ? { at: parsed.at, type: parsed.type, id: parsed.id, chat: parsed.chat }
      : null;
  } catch {
    return null;
  }
};

const sanitizePagination = (input: { page: number; perPage: number }) => {
  const page = Number.isInteger(input.page) && input.page > 0 ? input.page : 1;
  const perPage = Number.isInteger(input.perPage) && input.perPage > 0 ? Math.min(input.perPage, 100) : 20;
  return { page, perPage, offset: (page - 1) * perPage };
};

const searchPattern = (value: string | undefined): string | null => {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? `%${trimmed}%` : null;
};

const conversationSearchRank = (backend: ConversationSearchBackend, query: string) => {
  const exactBoost = sql`
    CASE
      WHEN LOWER(conversation.title) = LOWER(${query}) THEN 40
      WHEN LOWER(conversation.title) LIKE ${`%${query.toLowerCase()}%`} THEN 20
      WHEN LOWER(conversation.search_summary) LIKE ${`%${query.toLowerCase()}%`} THEN 8
      WHEN LOWER(conversation.description) LIKE ${`%${query.toLowerCase()}%`} THEN 4
      ELSE 0
    END
  `;
  if (backend === "bm25") {
    return sql`${exactBoost}
      - (conversation.search_text <@> to_bm25query(${query}, ${CONVERSATION_BM25_INDEX}))
      + COALESCE((
          SELECT MAX(-(message.search_text <@> to_bm25query(${query}, ${MESSAGE_BM25_INDEX})))
          FROM ai.messages message
          WHERE message.conversation_id = conversation.id AND message.search_text <> ''
        ), 0)`;
  }
  return sql`${exactBoost}
    + ts_rank_cd(conversation.search_document, websearch_to_tsquery('simple', ${query})) * 10
    + COALESCE((
        SELECT MAX(ts_rank_cd(message.search_document, websearch_to_tsquery('simple', ${query})))
        FROM ai.messages message
        WHERE message.conversation_id = conversation.id
      ), 0)`;
};

const withConversationSearchBackend = async <T>(
  query: string | null,
  run: (backend: ConversationSearchBackend) => Promise<T>,
): Promise<T> => {
  const backend = query ? await getConversationSearchBackend() : "native";
  try {
    return await run(backend);
  } catch (error) {
    if (backend !== "bm25" || !isSearchCapabilityError(error)) throw error;
    log.warn("Conversation BM25 query failed; falling back to native PostgreSQL FTS", {
      error: error instanceof Error ? error.message : String(error),
    });
    conversationSearchBackendPromise = Promise.resolve("native");
    return run("native");
  }
};

const parseJsonValue = <T>(value: unknown): T => {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
};

const parseCapabilityActionReview = (value: unknown): CapabilityActionReview | undefined => {
  if (value === null || value === undefined) return undefined;
  const parsed = CapabilityActionReviewSchema.safeParse(parseJsonValue(value));
  return parsed.success ? parsed.data : undefined;
};

const fieldSource = (value: string | null): AiConversation["titleSource"] => (value === "auto" || value === "user" ? value : "default");

// Pins stay active; otherwise explicit choices win and automatic completion never hides pending work.
const effectiveDone = () => sql`(conversation.pinned_at IS NULL AND COALESCE(conversation.done,
  conversation.last_used_at <= now() - interval '7 days'
  AND NOT EXISTS (SELECT 1 FROM ai.chat_tasks schedule WHERE schedule.conversation_id = conversation.id AND schedule.state = 'active')
  AND NOT EXISTS (SELECT 1 FROM ai.turns active_turn
    WHERE active_turn.conversation_id = conversation.id
      AND NOT COALESCE(active_turn.run_config ? 'background', false)
      AND active_turn.status IN ('queued', 'running', 'waiting_for_action'))
  AND NOT EXISTS (SELECT 1 FROM ai.queued_messages pending WHERE pending.conversation_id = conversation.id AND pending.status IN ('pending','failed'))))`;

const browserWorkPending = () => sql`(
  latest.status = 'waiting_for_action'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(latest.live_blocks) = 'array' THEN latest.live_blocks ELSE '[]'::jsonb END) block
    WHERE block->>'kind' = 'tool' AND block->>'status' = 'awaiting_client' AND block->>'frontendMode' = 'client'
  )
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(latest.live_blocks) = 'array' THEN latest.live_blocks ELSE '[]'::jsonb END) block
    WHERE block->>'kind' = 'tool' AND (
      block->>'status' = 'awaiting_approval'
      OR (block->>'status' = 'awaiting_client' AND COALESCE(block->>'frontendMode', '') <> 'client')
    )
  )
)`;

const conversationRunStatus = (status: AiTurnStatus | null | undefined, browserPending = false): AiConversation["runStatus"] => {
  if (status === "queued") return "queued";
  if (status === "running") return "running";
  if (status === "waiting_for_action") return browserPending ? "waiting_for_browser" : "needs_attention";
  if (status === "failed") return "failed";
  return "idle";
};

// Bun SQL may return historical JSON payloads as string-encoded JSON.
const todoMessageJson = () => sql`(CASE WHEN jsonb_typeof(message) = 'string' THEN (message #>> '{}')::jsonb ELSE message END)`;
const todoMetaJson = () => sql`(CASE WHEN jsonb_typeof(meta) = 'string' THEN (meta #>> '{}')::jsonb ELSE meta END)`;

// A scheduled result arriving during an interactive turn becomes context on the next turn.
const visibleToTurn = (turnId?: string) => sql`(
  ${turnId ?? null}::text IS NULL OR NOT COALESCE(meta ? 'scheduledTask', false) OR seq < ALL (
    SELECT input_message.seq FROM ai.messages input_message
    WHERE input_message.loop_id = ${turnId ?? null} AND input_message.role = 'user'
  )
)`;

const rowToConversation = (row: ConversationRow): AiConversation => ({
  ...(row.activity ? {activity:row.activity} : {}),
  id: row.id,
  hasActiveSchedule: Boolean(row.has_active_schedule),
  shortId: row.short_id,
  title: row.title,
  titleSource: fieldSource(row.title_source),
  description: row.description ?? "",
  descriptionSource: fieldSource(row.description_source),
  keywords: row.keywords ?? [],
  pinnedAt: row.pinned_at ? iso(row.pinned_at) : null,
  archivedAt: row.archived_at ? iso(row.archived_at) : null,
  done: row.done,
  isDone: row.pinned_at ? false : row.is_done ?? row.done ?? (
    new Date(row.last_used_at).getTime() <= Date.now() - 7 * 86400000
    && !row.has_active_schedule
    && !["queued", "running", "waiting_for_action"].includes(row.latest_turn_status ?? "")
  ),
  lastUsedAt: iso(row.last_used_at),
  runStatus: conversationRunStatus(row.latest_turn_status, row.latest_browser_pending),
  runError: row.latest_turn_status === "failed" ? row.latest_turn_error?.trim() || "Assistant response failed." : null,
  unreadCompletion:
    Boolean(row.background_received_at && (!row.last_viewed_at || new Date(row.background_received_at).getTime() > new Date(row.last_viewed_at).getTime())) ||
    row.latest_turn_status === "completed" &&
    Boolean(row.latest_turn_completed_at) &&
    (!row.last_viewed_at || new Date(row.latest_turn_completed_at!).getTime() > new Date(row.last_viewed_at).getTime()),
  projectId: row.project_id,
  draft: {
    content: parseJsonValue<AiConversationDraft["content"]>(row.draft_content ?? []),
    revision: Number(row.draft_revision ?? 0),
    updatedAt: row.draft_updated_at ? iso(row.draft_updated_at) : null,
  },
  createdByUserId: row.created_by_user_id,
  launchedByAppId: row.launched_by_app_id,
  allowedTools: row.allowed_tools ?? null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const rowToEnrichmentRun = (row: EnrichmentRunRow): AiEnrichmentRun => ({
  id: row.id,
  conversationId: row.conversation_id,
  status: row.status,
  trigger: row.trigger,
  modelProfileId: row.model_profile_id,
  mode: row.mode,
  durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
  titleUpdated: row.title_updated,
  keywordsCount: Number(row.keywords_count ?? 0),
  error: row.error,
  createdAt: iso(row.created_at),
});

const rowToEnrichmentOverviewRun = (row: EnrichmentRunRow): AiEnrichmentOverviewRun => ({
  ...rowToEnrichmentRun(row),
  conversationTitle: row.conversation_title ?? "",
});

const numberOrNull = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const intValue = (value: number | string | null | undefined): number => Math.max(0, Math.trunc(numberOrNull(value) ?? 0));

const rowToMessage = (row: MessageRow): AiStoredMessage => {
  const message = parseJsonValue<Message>(row.message);
  return {
    id: row.id,
    shortId: row.short_id,
    conversationId: row.conversation_id,
    seq: row.seq,
    kind: row.kind,
    message,
    loopId: row.loop_id,
    modelProfileId: row.model_profile_id,
    providerModel: row.provider_model,
    usage: row.usage ? parseJsonValue<Usage>(row.usage) : null,
    stopReason: row.stop_reason,
    loopAggregate: row.loop_aggregate ? parseJsonValue<LoopAggregate>(row.loop_aggregate) : null,
    loopDoneReason: row.loop_done_reason,
    compactedAt: row.compacted_at ? iso(row.compacted_at) : null,
    meta: row.meta ? parseJsonValue<AiStoredMessage["meta"]>(row.meta) : null,
    feedback:
      Number(row.feedback_rating) === 1 || Number(row.feedback_rating) === -1
        ? {
            rating: Number(row.feedback_rating) === 1 ? "up" : "down",
            reasons: (row.feedback_reasons ?? []) as NonNullable<AiStoredMessage["feedback"]>["reasons"],
            comment: row.feedback_comment,
            updatedAt: iso(row.feedback_updated_at!),
          }
        : null,
    createdAt: iso(row.created_at),
  };
};

const rowToTurn = (row: TurnRow): AiTurn => ({
  deadline: row.deadline ? iso(row.deadline) : null,
  runBudgetMs: row.run_budget_ms ?? null,
  cancelRequestedAt: row.cancel_requested_at ? iso(row.cancel_requested_at) : null,
  id: row.id,
  shortId: row.short_id,
  conversationId: row.conversation_id,
  status: row.status,
  attempt: Number(row.attempt ?? 0),
  modelProfileId: row.model_profile_id,
  createdAt: iso(row.created_at),
  completedAt: row.completed_at ? iso(row.completed_at) : null,
  error: row.error,
});

const rowToLiveBlocks = (row: TurnRow): AiTurnBlock[] => {
  if (!row.live_blocks) return [];
  const parsed = parseJsonValue<AiTurnBlock[]>(row.live_blocks);
  return Array.isArray(parsed) ? parsed : [];
};

const pendingActionToPublicEvent = (row: PendingActionRow): AiPendingTurnAction =>
  row.kind === "client_tool"
    ? {
        type: "frontend_tool",
        turnId: row.turn_id,
        conversationId: row.conversation_id,
        callId: row.call_id,
        name: row.tool_name,
        args: row.args,
        mode: row.frontend_mode ?? "client",
      }
    : {
        type: "approval_request",
        turnId: row.turn_id,
        conversationId: row.conversation_id,
        callId: row.call_id,
        name: row.tool_name,
        args: row.args,
        message: row.message ?? undefined,
        review: parseCapabilityActionReview(row.review),
        allowAlways: row.allow_always,
      };

const rowToPendingActionRecord = (row: PendingActionRow): AiPendingTurnActionRecord => ({
  turnId: row.turn_id,
  conversationId: row.conversation_id,
  callId: row.call_id,
  kind: row.kind,
  status: row.status,
  name: row.tool_name,
  args: row.args,
  message: row.message ?? undefined,
  review: parseCapabilityActionReview(row.review),
  approvalScope: row.approval_scope,
  allowAlways: row.allow_always,
  frontendMode: row.frontend_mode ?? undefined,
  resolvedEvent: row.resolved_event ? parseJsonValue<InboundEvent>(row.resolved_event) : null,
});

const rowToTurnSteer = (row: TurnSteerRow): AiTurnSteer => ({
  id: row.id,
  conversationId: row.conversation_id,
  turnId: row.turn_id,
  seq: Number(row.seq),
  clientRequestId: row.client_request_id,
  text: row.text,
  status: row.status,
  messageId: row.message_id,
  createdAt: iso(row.created_at),
  consumedAt: row.consumed_at ? iso(row.consumed_at) : null,
});

const boundedMs = (value: number, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
};

const loadConversationSummary = async (input: {
  conversationId?: string;
  shortId?: string;
  ownerUserId?: string;
  archived?: boolean;
}): Promise<AiConversation | null> => {
  const rows = await sql<ConversationRow[]>`
    SELECT
      conversation.*,
      ${effectiveDone()} AS is_done,
        EXISTS (SELECT 1 FROM ai.chat_tasks schedule WHERE schedule.conversation_id = conversation.id AND schedule.state = 'active') AS has_active_schedule,
      latest.status AS latest_turn_status,
      ${browserWorkPending()} AS latest_browser_pending,
      latest.error AS latest_turn_error,
      latest.completed_at AS latest_turn_completed_at
    FROM ai.conversations conversation
    LEFT JOIN LATERAL (
      SELECT status, error, completed_at, live_blocks
      FROM ai.turns
      WHERE conversation_id = conversation.id AND NOT COALESCE(run_config ? 'background', false)
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) latest ON TRUE
    WHERE (${input.conversationId ?? null}::uuid IS NULL OR conversation.id = ${input.conversationId ?? null}::uuid)
      AND (${input.shortId ?? null}::text IS NULL OR conversation.short_id = ${input.shortId ?? null})
      AND (${input.ownerUserId ?? null}::uuid IS NULL OR conversation.created_by_user_id = ${input.ownerUserId ?? null})
      AND (${Boolean(input.archived)}::boolean = (conversation.archived_at IS NOT NULL))
    LIMIT 1
  `;
  if (!rows[0]) return null;
  const plans = await sql<{ seq: number; plan: unknown }[]>`
    SELECT seq, CASE WHEN role = 'tool_result' THEN ${todoMessageJson()}->'result' ELSE ${todoMetaJson()}->'todoPlan' END AS plan
    FROM ai.messages WHERE conversation_id = ${rows[0].id}
      AND ((role = 'tool_result' AND ${todoMessageJson()}->>'name' = 'todo_write' AND COALESCE(${todoMessageJson()}->>'isError','false') = 'false') OR ${todoMetaJson()} ? 'todoPlan')
    ORDER BY seq DESC, id DESC LIMIT 1
  `;
  const plan = parseAiTodoPlan(plans[0]?.plan);
  return { ...rowToConversation(rows[0]), ...(plan ? { todoPlan: { seq: Number(plans[0]!.seq), todos: plan.todos } } : {}) };
};

const firstText = (message: Message): string => {
  if (message.role !== "user") return "";
  const part = message.content.find(
    (entry): entry is string | { type: "text"; text: string } => typeof entry === "string" || entry.type === "text",
  );
  if (!part) return "";
  const text = typeof part === "string" ? part : part.text;
  return text.trim().replace(/\s+/g, " ").slice(0, 80);
};

const messageColumns = (message: Message) => ({
  usage: message.role === "assistant" ? (message.usage ?? null) : null,
  providerModel: message.role === "assistant" ? (message.model ?? null) : null,
  stopReason: message.role === "assistant" ? (message.stopReason ?? null) : null,
});

const messageSearchText = (message: Message): string => {
  if (message.role === "tool_result") return "";
  const text = message.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part.type === "text") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text.slice(0, SEARCH_TEXT_MAX_CHARS);
};

/** Insert a message inside an open conversation-lock transaction and bump the conversation. */
const insertMessageLocked = async (
  input: {
    conversationId: string;
    message: Message;
    kind?: "message" | "summary";
    seq?: number;
    loopId?: string | null;
    modelProfileId?: string | null;
    meta?: AiStoredMessage["meta"];
  },
  db: typeof sql = sql,
): Promise<MessageRow> => {
  const { usage, providerModel, stopReason } = messageColumns(input.message);
  const seqRows = input.seq
    ? [{ seq: input.seq }]
    : await db<
        { seq: number }[]
      >`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM ai.messages WHERE conversation_id = ${input.conversationId} AND seq > 0`;
  const seq = seqRows[0]?.seq ?? 1;

  const rows = await withAiShortIdForDb(
    db,
    "idx_ai_messages_conversation_short_id",
    (attempt, shortId) => attempt<MessageRow[]>`
    INSERT INTO ai.messages (
      short_id,
      conversation_id,
      seq,
      kind,
      role,
      message,
      search_text,
      loop_id,
      model_profile_id,
      provider_model,
      usage,
      stop_reason,
      meta
    )
    VALUES (
      ${shortId},
      ${input.conversationId},
      ${seq},
      ${input.kind ?? "message"},
      ${input.message.role},
      ${JSON.stringify(input.message)}::text::jsonb,
      ${messageSearchText(input.message)},
      ${input.loopId ?? null},
      ${input.modelProfileId ?? null},
      ${providerModel},
      ${usage ? JSON.stringify(usage) : null}::text::jsonb,
      ${stopReason},
      ${input.meta ? JSON.stringify(input.meta) : null}::text::jsonb
    )
    RETURNING *
  `,
  );

  const title = firstText(input.message);
  if (seq === 1 && title) {
    // First-message snapshot title stays title_source 'default': it is a
    // placeholder ("Hi", …) that the enrichment job may replace freely.
    // 'auto' is reserved for enrichment-set titles.
    await db`
      UPDATE ai.conversations
      SET title = ${title}, updated_at = now()
      WHERE id = ${input.conversationId}
    `;
  } else {
    await db`UPDATE ai.conversations SET updated_at = now() WHERE id = ${input.conversationId}`;
  }
  return rows[0]!;
};

/** Append a turn-owned (assistant/tool_result/summary) message, guarded by lease ownership in one statement. */
const appendTurnOwnedMessage = async (input: {
  background?: boolean;
  conversationId: string;
  turnId: string;
  leaseOwner: string;
  message: Message;
  kind?: "message" | "summary";
  seq?: number;
  loopId: string | null;
  modelProfileId?: string | null;
  meta?: AiStoredMessage["meta"];
}): Promise<AiStoredMessage | null> => {
  return sql.begin(async tx => {
  if (!input.background) await tx`SELECT id FROM ai.conversations WHERE id = ${input.conversationId}::uuid FOR UPDATE`;
  const { usage, providerModel, stopReason } = messageColumns(input.message);
  const rows = await withAiShortIdForDb(tx,
    "idx_ai_messages_conversation_short_id",
    (attempt, shortId) => attempt<MessageRow[]>`
    INSERT INTO ${sql(input.background ? "ai.task_messages" : "ai.messages")} (
      short_id,
      conversation_id,
      seq,
      kind,
      role,
      message,
      loop_id,
      model_profile_id,
      provider_model,
      usage,
      stop_reason,
      meta
    )
    SELECT
      ${shortId},
      ${input.conversationId},
      CASE
        WHEN NOT ${Boolean(input.background)} AND ${input.kind === 'summary'} AND ${input.seq ?? null}::int IS NOT NULL AND ${input.seq ?? null}::int > 0 THEN ${input.seq ?? null}::int
        ELSE (SELECT COALESCE(MAX(seq), 0) + 1 FROM ${sql(input.background ? "ai.task_messages" : "ai.messages")} WHERE conversation_id = ${input.conversationId} AND seq > 0 AND (NOT ${Boolean(input.background)} OR loop_id = ${input.turnId}))
      END,
      ${input.kind ?? "message"},
      ${input.message.role},
      ${JSON.stringify(input.message)}::text::jsonb,
      ${input.loopId},
      ${input.modelProfileId ?? null},
      ${providerModel},
      ${usage ? JSON.stringify(usage) : null}::text::jsonb,
      ${stopReason},
      ${input.meta ? JSON.stringify(input.meta) : null}::text::jsonb
    WHERE EXISTS (
      SELECT 1
      FROM ai.turns
      WHERE id = ${input.turnId}
        AND conversation_id = ${input.conversationId}
        AND status IN ('running', 'waiting_for_action')
        AND lease_owner = ${input.leaseOwner}
    )
    RETURNING *
  `,
  );
  if (rows[0]) {
    if (!input.background) await tx`UPDATE ai.conversations SET updated_at = now() WHERE id = ${input.conversationId}`;
    return rowToMessage(rows[0]);
  }
  return null;
  });
};

const toolMessageMeta = (
  message: Message,
  presentations: ReadonlyMap<string, AiToolPresentation> | undefined,
  rejectedToolCallIds: ReadonlySet<string> | undefined,
): AiStoredMessage["meta"] => {
  if (message.role === "tool_result" && rejectedToolCallIds?.has(message.callId)) {
    return { toolOutcomes: { [message.callId]: "rejected" } };
  }
  if (message.role !== "assistant" || !presentations || presentations.size === 0) return null;
  const toolPresentations = Object.fromEntries(
    message.content.flatMap((block) => {
      if (block.type !== "tool_call") return [];
      const presentation = presentations.get(block.name);
      return presentation ? ([[block.id, presentation]] as const) : [];
    }),
  );
  return Object.keys(toolPresentations).length > 0 ? { toolPresentations } : null;
};

export const saveAiDraftInTransaction = async (
  tx: SQL,
  input: Parameters<AiConversationService["saveDraft"]>[0],
): ReturnType<AiConversationService["saveDraft"]> => {
  const [conversation] = await tx<{ draft_content: unknown; draft_revision: number | string; draft_updated_at: Date | string | null }[]>`
        SELECT draft_content, draft_revision, draft_updated_at
        FROM ai.conversations
        WHERE id = ${input.conversationId}::uuid
          AND created_by_user_id = ${input.ownerUserId}::uuid
          AND archived_at IS NULL
        FOR UPDATE
      `;
  if (!conversation) return { ok: false as const, reason: "not_found" as const };
  if (Number(conversation.draft_revision) !== input.expectedRevision) {
    return { ok: false as const, reason: "conflict" as const };
  }
  const [sameDraft] = await tx<{ same: boolean }[]>`
        SELECT ${JSON.stringify(input.content)}::text::jsonb = ${JSON.stringify(parseJsonValue(conversation.draft_content))}::text::jsonb AS same
      `;
  if (sameDraft?.same) {
    return {
      ok: true as const,
      draft: {
        content: input.content,
        revision: Number(conversation.draft_revision),
        updatedAt: conversation.draft_updated_at ? iso(conversation.draft_updated_at) : null,
      },
    };
  }

  for (const part of input.content) {
    if (part.type !== "file") continue;
    const [file] = await tx<{ exists: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM ai.files
            WHERE conversation_id = ${input.conversationId}::uuid
              AND path = ${part.path}
              AND media_type = ${part.mediaType}
              AND size = ${part.size}
              AND version = ${part.version}
          ) AS exists
        `;
    if (!file?.exists) throw new Error(`Conversation file changed or no longer exists: ${part.path}`);
  }

  const [saved] = await tx<{ draft_content: unknown; draft_revision: number | string; draft_updated_at: Date | string }[]>`
        UPDATE ai.conversations
        SET draft_content = ${JSON.stringify(input.content)}::text::jsonb,
            draft_revision = draft_revision + 1,
            draft_updated_at = now()
        WHERE id = ${input.conversationId}::uuid
        RETURNING draft_content, draft_revision, draft_updated_at
      `;
  return {
    ok: true as const,
    draft: {
      content: parseJsonValue<AiConversationDraft["content"]>(saved!.draft_content),
      revision: Number(saved!.draft_revision),
      updatedAt: iso(saved!.draft_updated_at),
    },
  };
};

export const aiConversations: AiConversationService = {
  createConversation: async (input) => {
    const rows = await withAiShortId(
      "idx_ai_conversations_short_id",
      (shortId) => sql<ConversationRow[]>`
      INSERT INTO ai.conversations (
        short_id,
        title,
        description,
        project_id,
        draft_content,
        draft_revision,
        loaded_tools,
        draft_updated_at,
        created_by_user_id,
        launched_by_app_id,
        allowed_tools
      )
      SELECT
        ${shortId},
        ${input.title?.trim() || "New chat"},
        ${input.description?.trim() ?? ""},
        ${input.projectId ?? null}::uuid,
        ${JSON.stringify(input.draft ?? [])}::text::jsonb,
        ${input.draft?.length ? 1 : 0},
        ${toPgTextArray(input.preloadTools ?? [])}::text[],
        ${input.draft?.length ? new Date() : null},
        ${input.ownerUserId},
        ${input.launchedByAppId?.trim() || null},
        ${input.allowedTools === undefined ? null : toPgTextArray(input.allowedTools)}::text[]
      WHERE ${input.projectId ?? null}::uuid IS NULL
         OR EXISTS (SELECT 1 FROM ai.projects project WHERE project.id = ${input.projectId ?? null}::uuid)
      RETURNING *
    `,
    );
    if (!rows[0]) throw new Error("Project does not exist.");
    return rowToConversation(rows[0]);
  },

  forkConversation: async (input) => {
    return sql.begin(async (tx) => {
      const source = await tx<ConversationRow[]>`
        SELECT * FROM ai.conversations WHERE id = ${input.sourceConversationId}::uuid FOR SHARE
      `;
      if (!source[0]) throw new Error("Source conversation no longer exists.");
      const rows = await withAiShortIdForDb(
        tx,
        "idx_ai_conversations_short_id",
        (attempt, shortId) => attempt<ConversationRow[]>`
          INSERT INTO ai.conversations (
            short_id, title, description, project_id, created_by_user_id, allowed_tools
          )
          SELECT
            ${shortId}, ${input.title?.trim() || source[0]!.title}, description, project_id, ${input.ownerUserId}::uuid, allowed_tools
          FROM ai.conversations WHERE id = ${input.sourceConversationId}::uuid
          RETURNING *
        `,
      );
      const target = rows[0];
      if (!target) throw new Error("Failed to fork conversation.");
      await tx`
        INSERT INTO ai.messages (
          short_id, conversation_id, seq, kind, role, message, search_text, loop_id,
          model_profile_id, provider_model, usage, stop_reason, loop_aggregate, loop_done_reason, meta
        )
        SELECT
          short_id, ${target.id}::uuid, seq, kind, role, message, search_text, loop_id,
          model_profile_id, provider_model, usage, stop_reason, loop_aggregate, loop_done_reason,
          CASE WHEN ${todoMetaJson()} ? 'todoPlan' THEN jsonb_build_object('todoPlan', ${todoMetaJson()}->'todoPlan') ELSE NULL END
        FROM ai.messages
        WHERE conversation_id = ${input.sourceConversationId}::uuid
          AND compacted_at IS NULL
          AND seq <= ${Math.floor(input.throughSeq)}
        ORDER BY seq ASC
      `;
      await tx`
        INSERT INTO ai.files (conversation_id, path, bytes, media_type, size, origin, dictation_recorded_at, updated_at, version)
        SELECT ${target.id}::uuid, path, bytes, media_type, size, origin, dictation_recorded_at, updated_at, version
        FROM ai.files WHERE conversation_id = ${input.sourceConversationId}::uuid
      `;
      return rowToConversation(target);
    });
  },

  listConversations: async (input) => {
    const pattern = searchPattern(input.search);
    const query = input.search?.trim() || null;
    const archived = Boolean(input.archived);
    const status = input.status ?? null;
    const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 500) : 100;
    const refs = input.refs ?? [];
    const rows = await withConversationSearchBackend(query, async (backend) => {
      const order = query
        ? sql`${conversationSearchRank(backend, query)} DESC, conversation.pinned_at DESC NULLS LAST, conversation.updated_at DESC, conversation.created_at DESC`
        : input.done === true
          ? sql`conversation.last_used_at DESC, conversation.id DESC`
          : sql`conversation.pinned_at DESC NULLS LAST, conversation.updated_at DESC, conversation.created_at DESC`;
      return sql<ConversationRow[]>`
      SELECT
        conversation.*,
        ${effectiveDone()} AS is_done,
        EXISTS (SELECT 1 FROM ai.chat_tasks schedule WHERE schedule.conversation_id = conversation.id AND schedule.state = 'active') AS has_active_schedule,
        latest.status AS latest_turn_status,
        ${browserWorkPending()} AS latest_browser_pending,
        latest.error AS latest_turn_error,
        latest.completed_at AS latest_turn_completed_at
      FROM ai.conversations conversation
      LEFT JOIN LATERAL (
        SELECT status, error, completed_at, live_blocks
        FROM ai.turns
        WHERE NOT COALESCE(run_config ? 'background', false) AND conversation_id = conversation.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE conversation.created_by_user_id = ${input.ownerUserId}
        AND (${archived}::boolean = (conversation.archived_at IS NOT NULL))
        AND (${input.done ?? null}::boolean IS NULL OR ${input.done ?? null}::boolean = ${effectiveDone()})
        AND (${input.projectId ?? null}::uuid IS NULL OR conversation.project_id = ${input.projectId ?? null}::uuid)
        AND (NOT ${Boolean(input.unassigned)}::boolean OR conversation.project_id IS NULL)
        AND (${refs.length === 0}::boolean OR NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset((${JSON.stringify(refs)}::text)::jsonb) requested(type text, id text)
          WHERE NOT EXISTS (
            SELECT 1
            FROM ai.conversation_resource_refs indexed
            WHERE indexed.conversation_id = conversation.id
              AND indexed.resource_type = requested.type
              AND indexed.resource_id = requested.id
          )
        ))
        AND (${pattern}::text IS NULL
          OR LOWER(conversation.title) LIKE ${pattern}
          OR LOWER(conversation.description) LIKE ${pattern}
          OR LOWER(conversation.search_summary) LIKE ${pattern}
          OR LOWER(array_to_string(conversation.keywords, ' ')) LIKE ${pattern}
          OR conversation.search_document @@ websearch_to_tsquery('simple', ${query ?? ""})
          OR EXISTS (
            SELECT 1 FROM ai.messages message
            WHERE message.conversation_id = conversation.id
              AND (LOWER(message.search_text) LIKE ${pattern}
                OR message.search_document @@ websearch_to_tsquery('simple', ${query ?? ""}))
          ))
        AND (${status}::text IS NULL
          OR (${status} = 'running' AND (latest.status IN ('queued', 'running') OR ${browserWorkPending()}))
          OR (${status} = 'needs_attention' AND latest.status = 'waiting_for_action' AND NOT ${browserWorkPending()})
          OR (${status} = 'failed' AND latest.status = 'failed')
          OR (${status} = 'unread' AND (
            (latest.status = 'completed' AND latest.completed_at > COALESCE(conversation.last_viewed_at, '-infinity'))
            OR conversation.background_received_at > COALESCE(conversation.last_viewed_at, '-infinity'))))
      ORDER BY ${order}
      LIMIT ${limit}
    `;
    });
    return rows.map(rowToConversation);
  },

  listSidebarConversations: async (input) => {
    const rows = await sql<ConversationRow[]>`
      SELECT conversation.*, ${effectiveDone()} AS is_done,
        EXISTS (SELECT 1 FROM ai.chat_tasks schedule WHERE schedule.conversation_id = conversation.id AND schedule.state = 'active') AS has_active_schedule,
        latest.status AS latest_turn_status, ${browserWorkPending()} AS latest_browser_pending,
        latest.error AS latest_turn_error, latest.completed_at AS latest_turn_completed_at,
        jsonb_build_object('completed', COALESCE(progress.completed,0), 'total', COALESCE(progress.total,0),
          'step', progress.step, 'tool', ai.sidebar_tool_label(latest.live_blocks)->>'label') AS activity
      FROM ai.conversations conversation
      LEFT JOIN LATERAL (
        SELECT status, error, completed_at, live_blocks FROM ai.turns
        WHERE NOT COALESCE(run_config ? 'background', false) AND conversation_id = conversation.id ORDER BY created_at DESC, id DESC LIMIT 1
      ) latest ON TRUE
      LEFT JOIN LATERAL (
        SELECT CASE WHEN role = 'tool_result' THEN ${todoMessageJson()}->'result' ELSE ${todoMetaJson()}->'todoPlan' END AS plan
        FROM ai.messages WHERE conversation_id = conversation.id
          AND ((role = 'tool_result' AND ${todoMessageJson()}->>'name' = 'todo_write' AND COALESCE(${todoMessageJson()}->>'isError','false') = 'false') OR ${todoMetaJson()} ? 'todoPlan')
        ORDER BY seq DESC, id DESC LIMIT 1
      ) working ON TRUE
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE task->>'status' = 'completed')::int AS completed,
          count(*) FILTER (WHERE task->>'status' <> 'cancelled')::int AS total,
          max(task->>'content') FILTER (WHERE task->>'status' = 'in_progress') AS step
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(working.plan->'todos') = 'array' THEN working.plan->'todos' ELSE '[]'::jsonb END) task
      ) progress ON TRUE
      WHERE conversation.created_by_user_id = ${input.ownerUserId}::uuid
        AND conversation.archived_at IS NULL AND NOT ${effectiveDone()}
      ORDER BY conversation.pinned_at DESC NULLS LAST, conversation.last_used_at DESC, conversation.id
    `;
    return rows.map(rowToConversation);
  },

  listConversationsPage: async (input): Promise<AiConversationPage> => {
    const pattern = searchPattern(input.search);
    const query = input.search?.trim() || null;
    const archived = Boolean(input.archived);
    const status = input.status ?? null;
    const { page, perPage, offset } = sanitizePagination(input);
    const rows = await withConversationSearchBackend(query, async (backend) => {
      const order = query
        ? sql`${conversationSearchRank(backend, query)} DESC, conversation.pinned_at DESC NULLS LAST, conversation.updated_at DESC, conversation.created_at DESC`
        : input.done === true
          ? sql`conversation.last_used_at DESC, conversation.id DESC`
          : sql`conversation.pinned_at DESC NULLS LAST, conversation.updated_at DESC, conversation.created_at DESC`;
      return sql<ConversationRow[]>`
      SELECT
        conversation.*,
        ${effectiveDone()} AS is_done,
        EXISTS (SELECT 1 FROM ai.chat_tasks schedule WHERE schedule.conversation_id = conversation.id AND schedule.state = 'active') AS has_active_schedule,
        latest.status AS latest_turn_status,
        ${browserWorkPending()} AS latest_browser_pending,
        latest.error AS latest_turn_error,
        latest.completed_at AS latest_turn_completed_at
      FROM ai.conversations conversation
      LEFT JOIN LATERAL (
        SELECT status, error, completed_at, live_blocks
        FROM ai.turns
        WHERE NOT COALESCE(run_config ? 'background', false) AND conversation_id = conversation.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE conversation.created_by_user_id = ${input.ownerUserId}
        AND (${archived}::boolean = (conversation.archived_at IS NOT NULL))
        AND (${input.done ?? null}::boolean IS NULL OR ${input.done ?? null}::boolean = ${effectiveDone()})
        AND (${input.projectId ?? null}::uuid IS NULL OR conversation.project_id = ${input.projectId ?? null}::uuid)
        AND (NOT ${Boolean(input.unassigned)}::boolean OR conversation.project_id IS NULL)
        AND (${pattern}::text IS NULL
          OR LOWER(conversation.title) LIKE ${pattern}
          OR LOWER(conversation.description) LIKE ${pattern}
          OR LOWER(conversation.search_summary) LIKE ${pattern}
          OR LOWER(array_to_string(conversation.keywords, ' ')) LIKE ${pattern}
          OR conversation.search_document @@ websearch_to_tsquery('simple', ${query ?? ""})
          OR EXISTS (
            SELECT 1 FROM ai.messages message
            WHERE message.conversation_id = conversation.id
              AND (LOWER(message.search_text) LIKE ${pattern}
                OR message.search_document @@ websearch_to_tsquery('simple', ${query ?? ""}))
          ))
        AND (${status}::text IS NULL
          OR (${status} = 'running' AND (latest.status IN ('queued', 'running') OR ${browserWorkPending()}))
          OR (${status} = 'needs_attention' AND latest.status = 'waiting_for_action' AND NOT ${browserWorkPending()})
          OR (${status} = 'failed' AND latest.status = 'failed')
          OR (${status} = 'unread' AND (
            (latest.status = 'completed' AND latest.completed_at > COALESCE(conversation.last_viewed_at, '-infinity'))
            OR conversation.background_received_at > COALESCE(conversation.last_viewed_at, '-infinity'))))
      ORDER BY ${order}
      LIMIT ${perPage}
      OFFSET ${offset}
    `;
    });
    const countRows = await sql<CountRow[]>`
      SELECT COUNT(*) AS total
      FROM ai.conversations conversation
      LEFT JOIN LATERAL (
        SELECT status, completed_at, live_blocks
        FROM ai.turns
        WHERE NOT COALESCE(run_config ? 'background', false) AND conversation_id = conversation.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE conversation.created_by_user_id = ${input.ownerUserId}
        AND (${archived}::boolean = (conversation.archived_at IS NOT NULL))
        AND (${input.done ?? null}::boolean IS NULL OR ${input.done ?? null}::boolean = ${effectiveDone()})
        AND (${input.projectId ?? null}::uuid IS NULL OR conversation.project_id = ${input.projectId ?? null}::uuid)
        AND (NOT ${Boolean(input.unassigned)}::boolean OR conversation.project_id IS NULL)
        AND (${pattern}::text IS NULL
          OR LOWER(conversation.title) LIKE ${pattern}
          OR LOWER(conversation.description) LIKE ${pattern}
          OR LOWER(conversation.search_summary) LIKE ${pattern}
          OR LOWER(array_to_string(conversation.keywords, ' ')) LIKE ${pattern}
          OR conversation.search_document @@ websearch_to_tsquery('simple', ${query ?? ""})
          OR EXISTS (
            SELECT 1 FROM ai.messages message
            WHERE message.conversation_id = conversation.id
              AND (LOWER(message.search_text) LIKE ${pattern}
                OR message.search_document @@ websearch_to_tsquery('simple', ${query ?? ""}))
          ))
        AND (${status}::text IS NULL
          OR (${status} = 'running' AND (latest.status IN ('queued', 'running') OR ${browserWorkPending()}))
          OR (${status} = 'needs_attention' AND latest.status = 'waiting_for_action' AND NOT ${browserWorkPending()})
          OR (${status} = 'failed' AND latest.status = 'failed')
          OR (${status} = 'unread' AND (
            (latest.status = 'completed' AND latest.completed_at > COALESCE(conversation.last_viewed_at, '-infinity'))
            OR conversation.background_received_at > COALESCE(conversation.last_viewed_at, '-infinity'))))
    `;
    const total = Number(countRows[0]?.total ?? 0);
    return {
      items: rows.map(rowToConversation),
      total,
      page,
      perPage,
      hasNext: page * perPage < total,
    };
  },

  getConversation: async (input) => {
    return loadConversationSummary(input);
  },

  getConversationByShortId: async (input) => {
    return loadConversationSummary(input);
  },

  saveDraft: async (input) => sql.begin((tx) => saveAiDraftInTransaction(tx, input)),

  getLoadedTools: async (input) => {
    const rows = await sql<{ loaded_tools: string[] | null }[]>`
      SELECT loaded_tools
      FROM ai.conversations
      WHERE id = ${input.conversationId}::uuid
        AND archived_at IS NULL
    `;
    if (!rows[0]) throw new Error(`AI conversation ${input.conversationId} not found`);
    return rows[0].loaded_tools ?? [];
  },

  loadTools: async (input) =>
    sql.begin(async (tx) => {
      const rows = await tx<{ loaded_tools: string[] | null }[]>`
        SELECT loaded_tools
        FROM ai.conversations
        WHERE id = ${input.conversationId}::uuid
          AND archived_at IS NULL
        FOR UPDATE
      `;
      if (!rows[0]) throw new Error(`AI conversation ${input.conversationId} not found`);

      const current = rows[0].loaded_tools ?? [];
      const requested = [...new Set(input.names.map((name) => name.trim()).filter(Boolean))];
      const currentSet = new Set(current);
      const alreadyLoaded = requested.filter((name) => currentSet.has(name));
      const added = requested.filter((name) => !currentSet.has(name));
      const combined = [...current, ...added];
      const configuredLimit = Math.floor(input.maxLoadedTools ?? 0);
      const limit = Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : 0;
      const evicted = limit > 0 ? combined.slice(0, Math.max(0, combined.length - limit)) : [];
      const retained = evicted.length > 0 ? combined.slice(evicted.length) : combined;
      const retainedSet = new Set(retained);
      const loaded = added.filter((name) => retainedSet.has(name));

      await tx`
        UPDATE ai.conversations
        SET loaded_tools = ${toPgTextArray(retained)}::text[]
        WHERE id = ${input.conversationId}::uuid
      `;
      return { loaded, alreadyLoaded, evicted };
    }),

  indexConversationResources: async (input) => {
    const resources = [...new Map(input.resources.map((resource) => [`${resource.ref.type}\0${resource.ref.id}`, resource])).values()];
    if (!resources.length) return;
    await sql.begin(async (tx) => {
      for (const resource of resources) {
        await tx`
          INSERT INTO ai.conversation_resource_refs (
            conversation_id, resource_type, resource_id, title, preview, icon, href, source_turn_id, source_call_id
          ) VALUES (
            ${input.conversationId}, ${resource.ref.type}, ${resource.ref.id}, ${resource.title ?? null}, ${resource.preview ?? null},
            ${resource.icon ?? null}, ${resource.href ?? null}, ${input.turnId ?? null}, ${input.callId ?? null}
          )
          ON CONFLICT (conversation_id, resource_type, resource_id)
          DO UPDATE SET
            title = COALESCE(EXCLUDED.title, ai.conversation_resource_refs.title),
            preview = COALESCE(EXCLUDED.preview, ai.conversation_resource_refs.preview),
            icon = COALESCE(EXCLUDED.icon, ai.conversation_resource_refs.icon),
            href = COALESCE(EXCLUDED.href, ai.conversation_resource_refs.href),
            source_turn_id = COALESCE(EXCLUDED.source_turn_id, ai.conversation_resource_refs.source_turn_id),
            source_call_id = COALESCE(EXCLUDED.source_call_id, ai.conversation_resource_refs.source_call_id),
            last_seen_at = now()
        `;
      }
    });
  },

  listConversationResources: async (input) => {
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 20), 1), 100);
    const pattern = searchPattern(input.search);
    const cursor = decodeResourceCursor(input.before);
    const rows = await sql<ConversationResourceRefRow[]>`
      SELECT indexed.resource_type, indexed.resource_id, indexed.title, indexed.preview, indexed.icon, indexed.href,
             source_turn.short_id AS source_turn_id, indexed.source_call_id, indexed.first_seen_at, indexed.last_seen_at
      FROM ai.conversation_resource_refs indexed
      LEFT JOIN ai.turns source_turn ON source_turn.id = indexed.source_turn_id
      WHERE indexed.conversation_id = ${input.conversationId}::uuid
        AND (${pattern}::text IS NULL OR LOWER(COALESCE(title, '') || ' ' || resource_type || ' ' || resource_id) LIKE ${pattern})
        AND (${cursor?.at ?? null}::timestamptz IS NULL OR (last_seen_at, resource_type, resource_id) <
          (${cursor?.at ?? null}::timestamptz, ${cursor?.type ?? null}::text, ${cursor?.id ?? null}::text))
      ORDER BY last_seen_at DESC, resource_type DESC, resource_id DESC
      LIMIT ${limit + 1}
    `;
    const page = rows.slice(0, limit);
    return {
      resources: page.map(rowToConversationResourceRef),
      ...(rows.length > limit && page.at(-1) ? { nextCursor: encodeResourceCursor(page.at(-1)!) } : {}),
    };
  },

  listUserConversationResources: async (input) => {
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 20), 1), 100);
    const pattern = searchPattern(input.search);
    const cursor = decodeResourceOccurrenceCursor(input.before);
    const rows = await sql<ConversationResourceOccurrenceRow[]>`
      SELECT indexed.resource_type, indexed.resource_id, indexed.title, indexed.preview, indexed.icon, indexed.href,
             source_turn.short_id AS source_turn_id, indexed.source_call_id, indexed.first_seen_at, indexed.last_seen_at,
             conversation.short_id AS conversation_short_id, conversation.title AS conversation_title,
             conversation.updated_at AS conversation_updated_at
      FROM ai.conversation_resource_refs indexed
      JOIN ai.conversations conversation ON conversation.id = indexed.conversation_id
      LEFT JOIN ai.turns source_turn ON source_turn.id = indexed.source_turn_id
      WHERE conversation.created_by_user_id = ${input.ownerUserId}::uuid
        AND conversation.archived_at IS NULL
        AND (${pattern}::text IS NULL OR LOWER(COALESCE(indexed.title, '') || ' ' || indexed.resource_type || ' ' || indexed.resource_id || ' ' || conversation.title) LIKE ${pattern})
        AND (${cursor?.at ?? null}::timestamptz IS NULL OR (indexed.last_seen_at, indexed.resource_type, indexed.resource_id, conversation.short_id) <
          (${cursor?.at ?? null}::timestamptz, ${cursor?.type ?? null}::text, ${cursor?.id ?? null}::text, ${cursor?.chat ?? null}::text))
      ORDER BY indexed.last_seen_at DESC, indexed.resource_type DESC, indexed.resource_id DESC, conversation.short_id DESC
      LIMIT ${limit + 1}
    `;
    const page = rows.slice(0, limit);
    return {
      resources: page.map(rowToConversationResourceOccurrence),
      ...(rows.length > limit && page.at(-1) ? { nextCursor: encodeResourceOccurrenceCursor(page.at(-1)!) } : {}),
    };
  },

  indexConversationSource: async (input) => {
    const source = input.source;
    await sql`
      INSERT INTO ai.conversation_sources (
        conversation_id, kind, source_key, title, preview, icon, href, source_turn_id, source_call_id
      ) VALUES (
        ${input.conversationId}::uuid, ${source.kind}, ${source.key}, ${source.title}, ${source.preview ?? null},
        ${source.icon ?? null}, ${source.href ?? null}, ${input.turnId ?? null}::uuid, ${input.callId ?? null}
      )
      ON CONFLICT (conversation_id, kind, source_key)
      DO UPDATE SET
        title = EXCLUDED.title,
        preview = COALESCE(EXCLUDED.preview, ai.conversation_sources.preview),
        icon = COALESCE(EXCLUDED.icon, ai.conversation_sources.icon),
        href = COALESCE(EXCLUDED.href, ai.conversation_sources.href),
        occurrences = ai.conversation_sources.occurrences +
          CASE WHEN ai.conversation_sources.source_call_id IS DISTINCT FROM EXCLUDED.source_call_id THEN 1 ELSE 0 END,
        source_turn_id = COALESCE(EXCLUDED.source_turn_id, ai.conversation_sources.source_turn_id),
        source_call_id = COALESCE(EXCLUDED.source_call_id, ai.conversation_sources.source_call_id),
        last_seen_at = now()
    `;
  },

  listConversationSources: async (input) => {
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 20), 1), 100);
    const pattern = searchPattern(input.search);
    const cursor = decodeResourceCursor(input.before);
    const rows = await sql<ConversationSourceRow[]>`
      SELECT *
      FROM (
        SELECT source.kind AS source_kind, source.source_key, source.title, source.preview,
               source.icon, source.href, NULL::text AS path, NULL::text AS media_type, NULL::bigint AS size,
               NULL::text AS resource_type, NULL::text AS resource_id, source.occurrences,
               turn.short_id AS source_turn_id, source.source_call_id, source.first_seen_at, source.last_seen_at
        FROM ai.conversation_sources source
        LEFT JOIN ai.turns turn ON turn.id = source.source_turn_id
        WHERE source.conversation_id = ${input.conversationId}::uuid

        UNION ALL

        SELECT 'file' AS source_kind, file.path AS source_key,
               regexp_replace(file.path, '^.*/', '') AS title, 'Attached to the conversation' AS preview,
               CASE WHEN file.media_type LIKE 'image/%' THEN 'ti ti-photo' ELSE 'ti ti-file' END AS icon,
               NULL::text AS href, file.path, file.media_type, file.size,
               NULL::text AS resource_type, NULL::text AS resource_id, 1 AS occurrences,
               NULL::text AS source_turn_id, NULL::text AS source_call_id,
               file.updated_at AS first_seen_at, file.updated_at AS last_seen_at
        FROM ai.files file
        WHERE file.conversation_id = ${input.conversationId}::uuid

        UNION ALL

        SELECT 'resource' AS source_kind, indexed.resource_type || ':' || indexed.resource_id AS source_key,
               COALESCE(indexed.title, indexed.resource_type || ' ' || indexed.resource_id) AS title,
               indexed.preview, indexed.icon, indexed.href, NULL::text AS path, NULL::text AS media_type, NULL::bigint AS size,
               indexed.resource_type, indexed.resource_id, 1 AS occurrences,
               turn.short_id AS source_turn_id, indexed.source_call_id, indexed.first_seen_at, indexed.last_seen_at
        FROM ai.conversation_resource_refs indexed
        LEFT JOIN ai.turns turn ON turn.id = indexed.source_turn_id
        WHERE indexed.conversation_id = ${input.conversationId}::uuid
      ) source
      WHERE (${pattern}::text IS NULL OR LOWER(source.title || ' ' || COALESCE(source.preview, '') || ' ' || source.source_key) LIKE ${pattern})
        AND (${cursor?.at ?? null}::timestamptz IS NULL OR (source.last_seen_at, source.source_kind, source.source_key) <
          (${cursor?.at ?? null}::timestamptz, ${cursor?.type ?? null}::text, ${cursor?.id ?? null}::text))
      ORDER BY source.last_seen_at DESC, source.source_kind DESC, source.source_key DESC
      LIMIT ${limit + 1}
    `;
    const page = rows.slice(0, limit);
    return {
      sources: page.map(rowToConversationSource),
      ...(rows.length > limit && page.at(-1) ? { nextCursor: encodeSourceCursor(page.at(-1)!) } : {}),
    };
  },

  getCapabilityInvocationOrigin: async (input) => {
    const rows = await sql<
      { conversation_id: string; conversation_short_id: string; turn_id: string; turn_short_id: string; call_id: string }[]
    >`
      SELECT call.conversation_id, conversation.short_id AS conversation_short_id,
             call.turn_id, turn.short_id AS turn_short_id, call.call_id
      FROM ai.tool_calls call
      JOIN ai.conversations conversation ON conversation.id = call.conversation_id
      JOIN ai.turns turn ON turn.id = call.turn_id
      WHERE call.idempotency_key = ${input.idempotencyKey}
        AND call.tool_name = ${input.toolName}
      LIMIT 1
    `;
    const row = rows[0];
    return row
      ? {
          conversationId: row.conversation_id,
          conversationShortId: row.conversation_short_id,
          turnId: row.turn_id,
          turnShortId: row.turn_short_id,
          callId: row.call_id,
        }
      : null;
  },

  createInterChatMessage: async (input) => {
    const existing = await sql<InterChatMessageRow[]>`${interChatMessageSelect()}
      WHERE message.idempotency_key = ${input.idempotencyKey}
        AND message.source_conversation_id = ${input.sourceConversationId}::uuid
        AND message.actor_user_id = ${input.actorUserId}::uuid
      LIMIT 1`;
    if (existing[0]) return { ok: true, message: rowToInterChatMessage(existing[0]) };

    const [pair] = await sql<{ source_id: string; target_id: string }[]>`
      SELECT source.id AS source_id, target.id AS target_id
      FROM ai.conversations source
      JOIN ai.turns source_turn ON source_turn.conversation_id = source.id AND source_turn.id = ${input.sourceTurnId}::uuid
      JOIN ai.conversations target ON target.short_id = ${input.targetChatId}
      WHERE source.id = ${input.sourceConversationId}::uuid
        AND source.created_by_user_id = ${input.actorUserId}::uuid
        AND target.created_by_user_id = ${input.actorUserId}::uuid
        AND source.archived_at IS NULL
        AND target.archived_at IS NULL
      LIMIT 1
    `;
    if (!pair) return { ok: false, reason: "not_found" };
    if (pair.source_id === pair.target_id) return { ok: false, reason: "same_chat" };
    const [recursive] = await sql<{ recursive: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM ai.messages
        WHERE conversation_id = ${input.sourceConversationId}::uuid
          AND loop_id = ${input.sourceTurnId}
          AND meta ? 'agentMessage'
      ) AS recursive
    `;
    if (recursive?.recursive) return { ok: false, reason: "recursive" };

    const inserted = await withAiShortId(
      "ai_inter_chat_messages_short_id_unique",
      (shortId) => sql<{ id: string }[]>`
        INSERT INTO ai.inter_chat_messages (
          short_id, source_conversation_id, source_turn_id, source_call_id,
          target_conversation_id, actor_user_id, text, idempotency_key
        ) VALUES (
          ${shortId}, ${input.sourceConversationId}, ${input.sourceTurnId}, ${input.sourceCallId},
          ${pair.target_id}, ${input.actorUserId}, ${input.text.trim()}, ${input.idempotencyKey}
        )
        ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
        RETURNING id
      `,
    );
    const rows = await sql<InterChatMessageRow[]>`${interChatMessageSelect()} WHERE message.id = ${inserted[0]!.id}::uuid LIMIT 1`;
    return { ok: true, message: rowToInterChatMessage(rows[0]!) };
  },

  listPendingInterChatMessages: async (input = {}) => {
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 100);
    const rows = await sql<InterChatMessageRow[]>`
      ${interChatMessageSelect()}
      WHERE message.status = 'pending'
        AND (${input.targetConversationId ?? null}::uuid IS NULL OR message.target_conversation_id = ${input.targetConversationId ?? null}::uuid)
        AND (${input.targetConversationId ?? null}::uuid IS NOT NULL OR NOT EXISTS (
          SELECT 1
          FROM ai.turns active_turn
          WHERE active_turn.conversation_id = message.target_conversation_id
            AND NOT COALESCE(active_turn.run_config ? 'background', false)
      AND active_turn.status IN ('queued', 'running', 'waiting_for_action')
        ))
        AND (${input.targetConversationId ?? null}::uuid IS NOT NULL OR message.id = (
          SELECT oldest.id
          FROM ai.inter_chat_messages oldest
          WHERE oldest.target_conversation_id = message.target_conversation_id
            AND oldest.status = 'pending'
          ORDER BY oldest.created_at ASC, oldest.id ASC
          LIMIT 1
        ))
      ORDER BY message.created_at ASC, message.id ASC
      LIMIT ${limit}
    `;
    return rows.map(rowToInterChatMessage);
  },

  failInterChatMessage: async (input) => {
    const rows = await sql<{ id: string }[]>`
      UPDATE ai.inter_chat_messages
      SET status = 'failed', error = ${input.error.slice(0, 2_000)}
      WHERE id = ${input.messageId}::uuid AND status = 'pending'
      RETURNING id
    `;
    return Boolean(rows[0]);
  },

  deliverInterChatMessage: async (input) => {
    const delivered = await sql.begin(async (tx) => {
      const rows = await tx<InterChatMessageRow[]>`
        ${interChatMessageSelect()}
        WHERE message.id = ${input.messageId}::uuid
        FOR UPDATE OF message
      `;
      const message = rows[0];
      if (!message) return { delivered: false as const, reason: "not_found" as const };
      if (message.status === "delivered") {
        const turn = message.target_turn_id
          ? await tx<TurnRow[]>`SELECT * FROM ai.turns WHERE id = ${message.target_turn_id}::uuid LIMIT 1`
          : [];
        return turn[0]
          ? { delivered: true as const, message: rowToInterChatMessage(message), turn: rowToTurn(turn[0]) }
          : { delivered: false as const, reason: "failed" as const };
      }
      if (message.status === "failed") return { delivered: false as const, reason: "failed" as const };

      const [target] = await tx<{ archived_at: Date | string | null }[]>`
        SELECT archived_at FROM ai.conversations WHERE id = ${message.target_conversation_id}::uuid FOR UPDATE
      `;
      if (!target || target.archived_at) {
        await tx`UPDATE ai.inter_chat_messages SET status = 'failed', error = 'Target chat is unavailable' WHERE id = ${message.id}::uuid`;
        return { delivered: false as const, reason: "failed" as const };
      }
      const [active] = await tx<{ id: string }[]>`
        SELECT id FROM ai.turns
        WHERE conversation_id = ${message.target_conversation_id}::uuid
          AND NOT COALESCE(run_config ? 'background', false)
          AND status IN ('queued', 'running', 'waiting_for_action')
        LIMIT 1
      `;
      if (active) return { delivered: false as const, reason: "busy" as const };

      const turnRows = await withAiShortIdForDb(
        tx,
        "idx_ai_turns_conversation_short_id",
        (attempt, shortId) => attempt<TurnRow[]>`
          INSERT INTO ai.turns (short_id, conversation_id, model_profile_id, status, run_config)
          VALUES (${shortId}, ${message.target_conversation_id}, ${input.modelProfileId}, 'queued', (${JSON.stringify(input.runConfig)}::text)::jsonb)
          RETURNING *
        `,
      );
      await tx`UPDATE ai.conversations SET done = CASE WHEN done IS TRUE THEN NULL ELSE done END, last_used_at = now() WHERE id = ${message.target_conversation_id}::uuid`;
      const turn = rowToTurn(turnRows[0]!);
      const targetMeta: NonNullable<AiStoredMessage["meta"]> = {
        agentMessage: {
          id: message.short_id,
          sourceChatId: message.source_chat_id,
          sourceTurnId: message.source_turn_short_id,
          sourceTitle: message.source_title,
          sourceHref: input.sourceHref,
        },
      };
      const messageRows = await withAiShortIdForDb(
        tx,
        "idx_ai_messages_conversation_short_id",
        (attempt, shortId) => attempt<MessageRow[]>`
          INSERT INTO ai.messages (short_id, conversation_id, seq, kind, role, message, search_text, loop_id, meta)
          VALUES (
            ${shortId}, ${message.target_conversation_id},
            (SELECT COALESCE(MAX(seq), 0) + 1 FROM ai.messages WHERE conversation_id = ${message.target_conversation_id} AND seq > 0),
            'message', ${input.userMessage.role}, (${JSON.stringify(input.userMessage)}::text)::jsonb,
            ${messageSearchText(input.userMessage)}, ${turn.id}, (${JSON.stringify(targetMeta)}::text)::jsonb
          )
          RETURNING *
        `,
      );
      const messageRow = messageRows[0]!;
      await tx`UPDATE ai.conversations SET updated_at = now() WHERE id = ${message.target_conversation_id}::uuid`;
      await tx`
        UPDATE ai.inter_chat_messages
        SET status = 'delivered', target_turn_id = ${turn.id}, target_message_id = ${messageRow.id}, delivered_at = now()
        WHERE id = ${message.id}::uuid
      `;
      const updated = await tx<InterChatMessageRow[]>`${interChatMessageSelect()} WHERE message.id = ${message.id}::uuid LIMIT 1`;
      return { delivered: true as const, message: rowToInterChatMessage(updated[0]!), turn };
    });
    return delivered;
  },

  updateConversationMetadata: async (input) => {
    const title = input.title.trim() || "New chat";
    const description = input.description?.trim() ?? "";
    const pinned = input.pinned ?? null;
    const rows = await sql<{ id: string }[]>`
      UPDATE ai.conversations
      SET title = ${title},
          title_source = CASE WHEN title IS DISTINCT FROM ${title} THEN 'user' ELSE title_source END,
          description = ${description},
          description_source = CASE WHEN description IS DISTINCT FROM ${description} THEN 'user' ELSE description_source END,
          pinned_at = CASE
            WHEN ${pinned}::boolean IS NULL THEN pinned_at
            WHEN ${pinned} THEN COALESCE(pinned_at, now())
            ELSE NULL
          END,
          updated_at = CASE
            WHEN title IS DISTINCT FROM ${title} OR description IS DISTINCT FROM ${description} THEN now()
            ELSE updated_at
          END
      WHERE id = ${input.conversationId}
        AND (${input.ownerUserId ?? null}::uuid IS NULL OR created_by_user_id = ${input.ownerUserId ?? null})
        AND archived_at IS NULL
      RETURNING id
    `;
    return rows[0] ? loadConversationSummary(input) : null;
  },

  setConversationProject: async (input) => {
    return sql.begin(async (tx) => {
      const conversations = await tx<ConversationRow[]>`
        SELECT *
        FROM ai.conversations
        WHERE id = ${input.conversationId}::uuid
          AND (${input.ownerUserId ?? null}::uuid IS NULL OR created_by_user_id = ${input.ownerUserId ?? null})
          AND archived_at IS NULL
        FOR UPDATE
      `;
      if (!conversations[0]) return { ok: false as const, reason: "not_found" as const };

      if (input.onlyUnassigned && conversations[0].project_id) return { ok: false as const, reason: "already_assigned" as const };

      const [activity] = await tx<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM ai.turns
          WHERE conversation_id = ${input.conversationId}::uuid
            AND status IN ('queued', 'running', 'waiting_for_action')
        ) OR (${Boolean(input.onlyUnassigned)}::boolean AND EXISTS (
          SELECT 1 FROM ai.queued_messages WHERE conversation_id = ${input.conversationId}::uuid AND status IN ('pending','failed')
        )) AS exists
      `;
      if (activity?.exists) return { ok: false as const, reason: "active_turn" as const };

      const updated = await tx<ConversationRow[]>`
        UPDATE ai.conversations
        SET project_id = ${input.projectId}::uuid,
            updated_at = CASE WHEN project_id IS DISTINCT FROM ${input.projectId}::uuid THEN now() ELSE updated_at END
        WHERE id = ${input.conversationId}::uuid
          AND (${input.projectId}::uuid IS NULL OR EXISTS (SELECT 1 FROM ai.projects WHERE id = ${input.projectId}::uuid))
        RETURNING *
      `;
      return updated[0]
        ? { ok: true as const, conversation: rowToConversation(updated[0]) }
        : { ok: false as const, reason: "not_found" as const };
    });
  },

  setConversationPinned: async (input) => {
    const rows = await sql<{ id: string }[]>`
      UPDATE ai.conversations
      SET pinned_at = CASE WHEN ${input.pinned} THEN COALESCE(pinned_at, now()) ELSE NULL END
      WHERE id = ${input.conversationId}
        AND (${input.ownerUserId ?? null}::uuid IS NULL OR created_by_user_id = ${input.ownerUserId ?? null})
        AND archived_at IS NULL
      RETURNING id
    `;
    return rows[0] ? loadConversationSummary(input) : null;
  },

  setConversationDone: async (input) => {
    const result = await sql.begin(async (tx) => {
      // Same lock as turn submission: completion cannot race a new message.
      const [conversation] = await tx<{ id: string }[]>`
        SELECT id FROM ai.conversations
        WHERE id = ${input.conversationId}::uuid AND created_by_user_id = ${input.ownerUserId}::uuid
          AND archived_at IS NULL FOR UPDATE
      `;
      if (!conversation) return { ok: false as const, reason: "not_found" as const };
      if (input.done) {
        const [active] = await tx<{ id: string }[]>`
          SELECT id FROM ai.turns WHERE conversation_id = ${input.conversationId}::uuid
            AND NOT COALESCE(run_config ? 'background', false) AND status IN ('queued', 'running', 'waiting_for_action') LIMIT 1
        `;
        const [pending] = await tx`SELECT id FROM ai.queued_messages WHERE conversation_id = ${input.conversationId}::uuid AND status IN ('pending','failed') LIMIT 1`;
        if (active || pending) return { ok: false as const, reason: "active_turn" as const };
      }
      await tx`UPDATE ai.conversations
        SET done = ${input.done}::boolean,
            last_used_at = CASE WHEN ${input.done}::boolean IS FALSE THEN now() ELSE last_used_at END
        WHERE id = ${input.conversationId}::uuid`;
      return { ok: true as const };
    });
    if (!result.ok) return result;
    const conversation = await loadConversationSummary(input);
    return conversation ? { ok: true as const, conversation } : { ok: false as const, reason: "not_found" as const };
  },

  archiveConversation: async (input) => {
    const rows = await sql<{ id: string }[]>`
      UPDATE ai.conversations
      SET archived_at = now(), pinned_at = NULL
      WHERE id = ${input.conversationId}
        AND (${input.ownerUserId ?? null}::uuid IS NULL OR created_by_user_id = ${input.ownerUserId ?? null})
        AND archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM ai.turns
          WHERE conversation_id = ai.conversations.id
            AND status IN ('queued', 'running', 'waiting_for_action')
        )
        AND NOT EXISTS (SELECT 1 FROM ai.queued_messages WHERE conversation_id = ai.conversations.id AND status IN ('pending','failed'))
      RETURNING id
    `;
    return Boolean(rows[0]);
  },

  restoreConversation: async (input) => {
    const rows = await sql<{ id: string }[]>`
      UPDATE ai.conversations
      SET archived_at = NULL
      WHERE id = ${input.conversationId}
        AND (${input.ownerUserId ?? null}::uuid IS NULL OR created_by_user_id = ${input.ownerUserId ?? null})
        AND archived_at IS NOT NULL
      RETURNING id
    `;
    return rows[0] ? loadConversationSummary(input) : null;
  },

  markConversationViewed: async (input) => {
    const rows = await sql<{ id: string }[]>`
      UPDATE ai.conversations
      SET last_viewed_at = now()
      WHERE id = ${input.conversationId}
        AND (${input.ownerUserId ?? null}::uuid IS NULL OR created_by_user_id = ${input.ownerUserId ?? null})
        AND archived_at IS NULL
      RETURNING id
    `;
    return Boolean(rows[0]);
  },

  listEnrichmentCandidates: async (input) => {
    const limit = Math.min(Math.max(input.limit, 1), 100);
    const onlyId = input.conversationId ?? null;
    // dirty_as_of carries updated_at at full microsecond precision (::text
    // round-trips losslessly); the ISO field is millisecond-truncated and
    // must never be written back as enriched_at.
    // Failure backoff: 5min * 2^fail_count, capped at 2^7 (~10.7h).
    // A manual reindex (conversationId set) skips the dirty and backoff checks.
    const rows = await sql<(ConversationRow & { dirty_as_of: string })[]>`
      SELECT c.*, c.updated_at::text AS dirty_as_of
      FROM ai.conversations c
      WHERE c.archived_at IS NULL
        AND (${onlyId}::uuid IS NULL OR c.id = ${onlyId}::uuid)
        AND (
          ${onlyId}::uuid IS NOT NULL
          OR (
            (c.enriched_at IS NULL OR c.updated_at > c.enriched_at)
            AND (
              c.enrich_failed_at IS NULL
              OR c.enrich_failed_at + (interval '5 minutes' * pow(2, LEAST(c.enrich_fail_count, 7))) < now()
            )
          )
        )
        AND EXISTS (SELECT 1 FROM ai.messages m WHERE m.conversation_id = c.id)
        AND NOT EXISTS (
          SELECT 1 FROM ai.turns t
          WHERE t.conversation_id = c.id AND NOT COALESCE(t.run_config ? 'background', false) AND t.status IN ('queued', 'running', 'waiting_for_action')
        )
      ORDER BY c.updated_at ASC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      ...rowToConversation(row),
      dirtyAsOf: row.dirty_as_of,
      enrichFailCount: row.enrich_fail_count ?? 0,
    }));
  },

  applyEnrichment: async (input) => {
    const title = input.title?.trim();
    const description = input.description?.trim();
    await sql`
      UPDATE ai.conversations
      SET keywords = ${toPgTextArray(input.keywords)}::text[],
          search_summary = ${input.searchSummary.trim()},
          title = COALESCE(${title ?? null}, title),
          title_source = CASE WHEN ${title ?? null}::text IS NOT NULL THEN 'auto' ELSE title_source END,
          description = COALESCE(${description ?? null}, description),
          description_source = CASE WHEN ${description ?? null}::text IS NOT NULL THEN 'auto' ELSE description_source END,
          enriched_at = ${input.dirtyAsOf}::timestamptz,
          enrich_failed_at = NULL,
          enrich_fail_count = 0
      WHERE id = ${input.conversationId}
    `;
  },

  markEnrichmentFailed: async (input) => {
    await sql`
      UPDATE ai.conversations
      SET enrich_failed_at = now(), enrich_fail_count = enrich_fail_count + 1
      WHERE id = ${input.conversationId}
    `;
  },

  recordEnrichmentRun: async (input) => {
    await sql`
      INSERT INTO ai.enrichment_runs (conversation_id, status, trigger, model_profile_id, mode, duration_ms, title_updated, keywords_count, error)
      VALUES (
        ${input.conversationId},
        ${input.status},
        ${input.trigger},
        ${input.modelProfileId ?? null},
        ${input.mode ?? null},
        ${input.durationMs ?? null},
        ${input.titleUpdated ?? false},
        ${input.keywordsCount ?? 0},
        ${input.error?.slice(0, 500) ?? null}
      )
    `;
    // Retention: keep the newest 20 runs per conversation.
    await sql`
      DELETE FROM ai.enrichment_runs
      WHERE conversation_id = ${input.conversationId}
        AND id NOT IN (
          SELECT id FROM ai.enrichment_runs
          WHERE conversation_id = ${input.conversationId}
          ORDER BY created_at DESC
          LIMIT 20
        )
    `;
  },

  listEnrichmentRuns: async (input) => {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const rows = await sql<EnrichmentRunRow[]>`
      SELECT * FROM ai.enrichment_runs
      WHERE conversation_id = ${input.conversationId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToEnrichmentRun);
  },

  getEnrichmentStatus: async (input) => {
    const rows = await sql<
      { enriched_at: Date | string | null; dirty: boolean; enrich_fail_count: number | null; keywords: string[] | null }[]
    >`
      SELECT enriched_at, (enriched_at IS NULL OR updated_at > enriched_at) AS dirty, enrich_fail_count, keywords
      FROM ai.conversations
      WHERE id = ${input.conversationId}
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      enrichedAt: row.enriched_at ? iso(row.enriched_at) : null,
      dirty: row.dirty,
      enrichFailCount: row.enrich_fail_count ?? 0,
      keywords: row.keywords ?? [],
    };
  },

  getEnrichmentOverview: async (): Promise<AiEnrichmentOverview> => {
    const [summary] = await sql<
      Array<{
        total_conversations: number | string;
        dirty_conversations: number | string;
        failed_conversations: number | string;
        oldest_dirty_at: Date | string | null;
        last_run_at: Date | string | null;
        avg_duration_ms: number | string | null;
        failed_runs_24h: number | string;
        total_runs_24h: number | string;
      }>
    >`
      WITH conversation_summary AS (
        SELECT
          count(*)::int AS total_conversations,
          count(*) FILTER (WHERE enriched_at IS NULL OR updated_at > enriched_at)::int AS dirty_conversations,
          count(*) FILTER (WHERE enrich_fail_count > 0)::int AS failed_conversations,
          min(updated_at) FILTER (WHERE enriched_at IS NULL OR updated_at > enriched_at) AS oldest_dirty_at
        FROM ai.conversations
        WHERE archived_at IS NULL
      ),
      run_summary AS (
        SELECT
          max(created_at) AS last_run_at,
          round(avg(duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::int AS avg_duration_ms,
          count(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS total_runs_24h,
          count(*) FILTER (WHERE status = 'failed' AND created_at >= now() - interval '24 hours')::int AS failed_runs_24h
        FROM ai.enrichment_runs
      )
      SELECT *
      FROM conversation_summary
      CROSS JOIN run_summary
    `;
    const recentRows = await sql<EnrichmentRunRow[]>`
      SELECT r.*, c.title AS conversation_title
      FROM ai.enrichment_runs r
      JOIN ai.conversations c ON c.id = r.conversation_id
      WHERE c.archived_at IS NULL
      ORDER BY r.created_at DESC
      LIMIT 8
    `;
    const totalRuns24h = intValue(summary?.total_runs_24h);
    const failedRuns24h = intValue(summary?.failed_runs_24h);
    return {
      totalConversations: intValue(summary?.total_conversations),
      dirtyConversations: intValue(summary?.dirty_conversations),
      failedConversations: intValue(summary?.failed_conversations),
      oldestDirtyAt: summary?.oldest_dirty_at ? iso(summary.oldest_dirty_at) : null,
      lastRunAt: summary?.last_run_at ? iso(summary.last_run_at) : null,
      avgDurationMs: numberOrNull(summary?.avg_duration_ms),
      failedRuns24h,
      totalRuns24h,
      errorRate24h: totalRuns24h > 0 ? (failedRuns24h / totalRuns24h) * 100 : 0,
      recentRuns: recentRows.map(rowToEnrichmentOverviewRun),
    };
  },

  listMessages: async (input) => {
    // Human view: compacted messages stay visible; superseded (compacted)
    // summaries are hidden. The active summary sorts after archived rows
    // sharing its checkpoint seq, marking where the model context begins.
    const rows = await sql<MessageRow[]>`
      SELECT *
      FROM ai.messages
      WHERE conversation_id = ${input.conversationId}
        AND NOT (kind = 'summary' AND compacted_at IS NOT NULL)
      ORDER BY seq ASC, (kind = 'summary')::int ASC
    `;
    return rows.map(rowToMessage);
  },

  listMessagesPage: async (input) => {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const beforeSeq = Number.isFinite(input.beforeSeq) ? (input.beforeSeq ?? null) : null;
    // Window by DISTINCT seq: a seq group (archived rows + their compaction
    // summary share one seq) is never split, so `beforeSeq = min(seq)` is a
    // lossless cursor. Same visibility rules as listMessages.
    const rows = await sql<MessageRow[]>`
      WITH page_seqs AS (
        SELECT DISTINCT seq
        FROM ai.messages
        WHERE conversation_id = ${input.conversationId}
          AND (${beforeSeq}::int IS NULL OR seq < ${beforeSeq})
          AND NOT (kind = 'summary' AND compacted_at IS NOT NULL)
        ORDER BY seq DESC
        LIMIT ${limit}
      )
      SELECT *
      FROM ai.messages
      WHERE conversation_id = ${input.conversationId}
        AND seq IN (SELECT seq FROM page_seqs)
        AND NOT (kind = 'summary' AND compacted_at IS NOT NULL)
      ORDER BY seq ASC, (kind = 'summary')::int ASC
    `;
    const messages = rows.map(rowToMessage);
    const oldestSeq = messages[0]?.seq;
    if (oldestSeq === undefined) return { messages, hasMore: false };
    const older = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM ai.messages
        WHERE conversation_id = ${input.conversationId}
          AND seq < ${oldestSeq}
          AND NOT (kind = 'summary' AND compacted_at IS NOT NULL)
      ) AS exists
    `;
    return { messages, hasMore: Boolean(older[0]?.exists) };
  },

  searchConversationMessages: async (input) => {
    const query = input.query.trim();
    if (!query) return { messages: [] };
    const beforeSeq = input.beforeSeq && input.beforeSeq > 0 ? Math.floor(input.beforeSeq) : null;
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 20), 1), 100);
    const pattern = `%${query.toLowerCase()}%`;
    const rows = await sql<(MessageRow & { page_rank: number | string })[]>`
      WITH matching AS (
        SELECT *, DENSE_RANK() OVER (ORDER BY seq DESC) AS page_rank
        FROM ai.messages
        WHERE conversation_id = ${input.conversationId}::uuid
          AND role <> 'tool_result'
          AND search_text <> ''
          AND NOT (kind = 'summary' AND compacted_at IS NOT NULL)
          AND (${beforeSeq}::int IS NULL OR seq < ${beforeSeq})
          AND (LOWER(search_text) LIKE ${pattern} OR search_document @@ websearch_to_tsquery('simple', ${query}))
      )
      SELECT *
      FROM matching
      WHERE page_rank <= ${limit + 1}
      ORDER BY seq DESC, (kind = 'summary')::int ASC, created_at DESC, id DESC
    `;
    const page = rows.filter((row) => Number(row.page_rank) <= limit);
    return {
      messages: page.map(rowToMessage),
      ...(rows.some((row) => Number(row.page_rank) > limit) && page.at(-1) ? { nextCursor: String(page.at(-1)!.seq) } : {}),
    };
  },

  listConversationTimeline: async (input): Promise<AiConversationTimelineEntry[]> => {
    const rows = await sql<TimelineRow[]>`
      WITH normalized AS (
        SELECT
          id,
          short_id,
          seq,
          role,
          loop_id,
          created_at,
          CASE
            WHEN jsonb_typeof(message) = 'string' THEN (message #>> '{}')::jsonb
            ELSE message
          END AS payload,
          CASE
            WHEN meta IS NULL THEN NULL
            WHEN jsonb_typeof(meta) = 'string' THEN (meta #>> '{}')::jsonb
            ELSE meta
          END AS meta_payload
        FROM ai.messages
        WHERE conversation_id = ${input.conversationId}
          AND kind = 'message'
          AND role IN ('user', 'assistant')
      ),
      message_text AS (
        SELECT
          normalized.*,
          COALESCE((
            SELECT string_agg(part ->> 'text', '' ORDER BY ordinal)
            FROM jsonb_array_elements(COALESCE(payload -> 'content', '[]'::jsonb)) WITH ORDINALITY AS content(part, ordinal)
            WHERE part ->> 'type' = 'text'
              AND NOT starts_with(COALESCE(part ->> 'text', ''), 'Attached files for this message:')
          ), '') AS visible_text,
          COALESCE((
            SELECT count(*) FILTER (WHERE part ->> 'type' = 'file')
              + sum(regexp_count(COALESCE(part ->> 'text', ''), '<attachment path='))
              + sum(regexp_count(COALESCE(part ->> 'text', ''), '--- file: '))
            FROM jsonb_array_elements(COALESCE(payload -> 'content', '[]'::jsonb)) AS content(part)
          ), 0) AS input_file_count
        FROM normalized
      ),
      user_rows AS (
        SELECT
          message_text.*,
          lead(seq) OVER (ORDER BY seq ASC) AS next_user_seq
        FROM message_text
        WHERE role = 'user'
      ),
      tool_summary AS (
        SELECT
          turn_id::text AS loop_id,
          count(*)::int AS tool_count,
          count(*) FILTER (WHERE tool_name = 'present' AND status = 'completed')::int AS output_file_count
        FROM ai.tool_calls
        WHERE conversation_id = ${input.conversationId}
        GROUP BY turn_id
      )
      SELECT
        users.short_id AS id,
        users.seq,
        COALESCE(timeline_turn.short_id, users.loop_id) AS loop_id,
        left(
          regexp_replace(
            regexp_replace(users.visible_text, '<attachment path="[^"]+" media-type="[^"]*" size="[0-9]+" />', '', 'g'),
            '\\s+',
            ' ',
            'g'
          ),
          240
        ) AS user_preview,
        left(COALESCE((
          SELECT string_agg(regexp_replace(assistant.visible_text, '\\s+', ' ', 'g'), ' ' ORDER BY assistant.seq)
          FROM message_text assistant
          WHERE assistant.role = 'assistant'
            AND assistant.seq > users.seq
            AND (users.next_user_seq IS NULL OR assistant.seq < users.next_user_seq)
        ), ''), 320) AS assistant_preview,
        COALESCE(users.meta_payload ? 'steerId', false) AS is_steer,
        users.input_file_count,
        COALESCE(tools.output_file_count, 0) AS output_file_count,
        COALESCE(tools.tool_count, 0) AS tool_count,
        users.created_at
      FROM user_rows users
      LEFT JOIN tool_summary tools ON tools.loop_id = users.loop_id
      LEFT JOIN ai.turns timeline_turn ON timeline_turn.id::text = users.loop_id
      ORDER BY users.seq ASC
    `;
    return rows.map((row) => ({
      id: row.id,
      seq: Number(row.seq),
      loopId: row.loop_id,
      userPreview: row.user_preview?.trim() || "Message",
      assistantPreview: row.assistant_preview?.trim() || "",
      isSteer: Boolean(row.is_steer),
      inputFileCount: Number(row.input_file_count ?? 0),
      outputFileCount: Number(row.output_file_count ?? 0),
      toolCount: Number(row.tool_count ?? 0),
      createdAt: iso(row.created_at),
    }));
  },

  listContextMessages: async (input) => {
    const rows = await sql<MessageRow[]>`
      SELECT *
      FROM ai.messages
      WHERE conversation_id = ${input.conversationId}
        AND compacted_at IS NULL
      ORDER BY seq ASC
    `;
    return rows.map(rowToMessage);
  },

  listTurnMessages: async (input) => {
    const rows = await sql<MessageRow[]>`
      SELECT *
      FROM (SELECT * FROM ai.messages UNION ALL SELECT * FROM ai.task_messages) messages
      WHERE conversation_id = ${input.conversationId}
        AND loop_id = ${input.loopId}
        AND (${input.includeCompacted ?? false} OR compacted_at IS NULL)
      ORDER BY seq ASC
    `;
    return rows.map(rowToMessage);
  },

  setMessageFeedback: async (input) => {
    const reasons = input.feedback.rating === "down" ? input.feedback.reasons : [];
    const comment = input.feedback.comment?.trim() || null;
    const rows = await sql<MessageRow[]>`
      UPDATE ai.messages
      SET feedback_rating = ${input.feedback.rating === "up" ? 1 : -1},
          feedback_reasons = ${toPgTextArray(reasons)}::text[],
          feedback_comment = ${comment},
          feedback_updated_at = now()
      WHERE conversation_id = ${input.conversationId}::uuid
        AND short_id = ${input.messageShortId}
        AND kind = 'message'
        AND role = 'assistant'
      RETURNING *
    `;
    return rows[0] ? (rowToMessage(rows[0]).feedback ?? null) : null;
  },

  clearMessageFeedback: async (input) => {
    const rows = await sql<{ id: string }[]>`
      UPDATE ai.messages
      SET feedback_rating = NULL,
          feedback_reasons = '{}'::text[],
          feedback_comment = NULL,
          feedback_updated_at = NULL
      WHERE conversation_id = ${input.conversationId}::uuid
        AND short_id = ${input.messageShortId}
        AND kind = 'message'
        AND role = 'assistant'
      RETURNING id
    `;
    return Boolean(rows[0]);
  },

  copyMessages: async (input) => {
    const throughSeq = Math.floor(input.throughSeq);
    if (!Number.isFinite(throughSeq) || throughSeq <= 0) return;

    await sql.begin(async (tx) => {
      await tx`SELECT id FROM ai.conversations WHERE id = ${input.targetConversationId} FOR UPDATE`;
      await tx`
        INSERT INTO ai.messages (
          short_id,
          conversation_id,
          seq,
          kind,
          role,
          message,
          search_text,
          loop_id,
          model_profile_id,
          provider_model,
          usage,
          stop_reason,
          loop_aggregate,
          loop_done_reason,
          meta
        )
        SELECT
          short_id,
          ${input.targetConversationId},
          seq,
          kind,
          role,
          message,
          search_text,
          loop_id,
          model_profile_id,
          provider_model,
          usage,
          stop_reason,
          loop_aggregate,
          loop_done_reason,
          CASE WHEN ${todoMetaJson()} ? 'todoPlan' THEN jsonb_build_object('todoPlan', ${todoMetaJson()}->'todoPlan') ELSE NULL END
        FROM ai.messages
        WHERE conversation_id = ${input.sourceConversationId}
          AND compacted_at IS NULL
          AND seq <= ${throughSeq}
        ORDER BY seq ASC
      `;
      await tx`UPDATE ai.conversations SET updated_at = now() WHERE id = ${input.targetConversationId}`;
    });
  },

  truncateMessagesFrom: async (input) => {
    const fromSeq = Math.floor(input.fromSeq);
    if (!Number.isFinite(fromSeq) || fromSeq <= 0) return;

    await sql.begin(async (tx) => {
      await tx`SELECT id FROM ai.conversations WHERE id = ${input.conversationId} FOR UPDATE`;
      await tx`
        DELETE FROM ai.messages
        WHERE conversation_id = ${input.conversationId}
          AND compacted_at IS NULL
          AND seq >= ${fromSeq}
      `;
      await tx`UPDATE ai.conversations SET updated_at = now() WHERE id = ${input.conversationId}`;
    });
  },

  setLatestAssistantLoopAggregate: async (input) => {
    const loopId = input.loopId ?? null;
    const config = loopId ? await aiConversations.getTurnRunConfig({ conversationId: input.conversationId, turnId: loopId }) : null;
    const table = config?.kind === "chat" && config.background ? "ai.task_messages" : "ai.messages";
    await sql`
      UPDATE ${sql(table)}
      SET loop_aggregate = ${JSON.stringify(input.aggregate)}::text::jsonb,
          loop_done_reason = ${input.doneReason}
      WHERE id = (
        SELECT id
        FROM ${sql(table)}
        WHERE conversation_id = ${input.conversationId}
          AND compacted_at IS NULL
          AND kind = 'message'
          AND role = 'assistant'
          AND (${loopId}::text IS NULL OR loop_id = ${loopId})
        ORDER BY seq DESC
        LIMIT 1
      )
    `;
  },

  compactMessages: async (input) => {
    const checkpointSeq = Math.floor(input.checkpointSeq);
    if (!Number.isFinite(checkpointSeq) || checkpointSeq <= 0) return;

    await sql.begin(async (tx) => {
      await tx`SELECT id FROM ai.conversations WHERE id = ${input.conversationId} FOR UPDATE`;
      const rows = await tx<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM ai.messages
        WHERE conversation_id = ${input.conversationId}
          AND compacted_at IS NULL
          AND seq <= ${checkpointSeq}
          AND ${visibleToTurn(input.turnId)}
      `;
      if ((rows[0]?.count ?? 0) === 0) return;

      const plans = await tx<{ plan: unknown }[]>`
        SELECT CASE WHEN role = 'tool_result' THEN ${todoMessageJson()}->'result' ELSE ${todoMetaJson()}->'todoPlan' END AS plan
        FROM ai.messages WHERE conversation_id = ${input.conversationId} AND seq <= ${checkpointSeq}
          AND ${visibleToTurn(input.turnId)}
          AND ((role = 'tool_result' AND ${todoMessageJson()}->>'name' = 'todo_write' AND COALESCE(${todoMessageJson()}->>'isError','false') = 'false') OR ${todoMetaJson()} ? 'todoPlan')
        ORDER BY seq DESC, id DESC LIMIT 1
      `;
      const todoPlan = parseAiTodoPlan(plans[0]?.plan);
      const archived = await tx<{ count: number }[]>`
        WITH archived AS (
          UPDATE ai.messages
          SET compacted_at = now()
          WHERE conversation_id = ${input.conversationId}
            AND compacted_at IS NULL
            AND seq <= ${checkpointSeq}
            AND ${visibleToTurn(input.turnId)}
          RETURNING id
        )
        SELECT COUNT(*)::int AS count FROM archived
      `;

      await insertMessageLocked(
        {
          conversationId: input.conversationId,
          message: todoPlan && input.summary.role === "assistant" ? { ...input.summary, content: [...input.summary.content, { type: "text", text: `Working plan at this checkpoint:\n${JSON.stringify(todoPlan)}` }] } : input.summary,
          kind: "summary",
          seq: checkpointSeq,
          loopId: null,
          modelProfileId: input.modelProfileId ?? null,
          meta: { compactedCount: archived[0]?.count ?? 0, ...(todoPlan ? { todoPlan } : {}) },
        },
        tx,
      );
    });
  },

  createCompactionTurn: async (input) => sql.begin(async (tx) => {
    const [conversation] = await tx<{ id: string }[]>`
      SELECT id FROM ai.conversations WHERE id = ${input.conversationId}::uuid AND archived_at IS NULL FOR UPDATE
    `;
    if (!conversation) throw new Error("Conversation not found.");
    const rows = await withAiShortIdForDb(tx, "idx_ai_turns_conversation_short_id", (attempt, shortId) => attempt<TurnRow[]>`
      INSERT INTO ai.turns (short_id, conversation_id, model_profile_id, status, run_config)
      VALUES (${shortId}, ${input.conversationId}, ${input.modelProfileId}, 'queued',
        (${input.runConfig ? JSON.stringify(input.runConfig) : null}::text)::jsonb)
      RETURNING *
    `);
    await tx`UPDATE ai.conversations SET done = CASE WHEN done IS TRUE THEN NULL ELSE done END, last_used_at = now() WHERE id = ${input.conversationId}::uuid`;
    return rowToTurn(rows[0]!);
  }),

  submitChatTurn: async (input) => {
    return await sql.begin(async (tx) => {
      const [conversation] = await tx<{ draft_revision: number | string; project_id: string | null }[]>`
        SELECT draft_revision, project_id FROM ai.conversations WHERE id = ${input.conversationId} FOR UPDATE
      `;
      if (!conversation) throw new Error("Conversation not found.");
      if (input.queuedMessageId) {
        const [head] = await tx<{id:string;status:string}[]>`SELECT id, status FROM ai.queued_messages WHERE conversation_id = ${input.conversationId}::uuid AND status IN ('pending','failed') ORDER BY position LIMIT 1`;
        const [busy] = await tx`SELECT id FROM ai.turns WHERE conversation_id = ${input.conversationId}::uuid AND NOT COALESCE(run_config ? 'background', false) AND status IN ('queued','running','waiting_for_action') LIMIT 1`;
        if (!head || head.id !== input.queuedMessageId || head.status !== 'pending' || busy) throw new Error("Queued message is no longer ready.");
      }
      if (!input.queuedMessageId) {
        const [queued] = await tx`SELECT id FROM ai.queued_messages WHERE conversation_id = ${input.conversationId}::uuid AND status IN ('pending','failed') LIMIT 1`;
        if (queued) throw new Error("Queued messages must be sent first.");
      }
      if (input.expectedDraftRevision !== undefined && Number(conversation.draft_revision) !== input.expectedDraftRevision) {
        throw new Error("Conversation draft changed before the turn was submitted.");
      }
      if (input.expectedProjectId !== undefined && conversation.project_id !== input.expectedProjectId) {
        throw new Error("Conversation Project changed before the turn was submitted.");
      }
      if (typeof input.truncateFromSeq === "number" && input.truncateFromSeq > 0) {
        await tx`
          DELETE FROM ai.messages
          WHERE conversation_id = ${input.conversationId}
            AND compacted_at IS NULL
            AND seq >= ${Math.floor(input.truncateFromSeq)}
        `;
      }
      const turnRows = await withAiShortIdForDb(
        tx,
        "idx_ai_turns_conversation_short_id",
        (attempt, shortId) => attempt<TurnRow[]>`
        INSERT INTO ai.turns (
          short_id,
          conversation_id,
          model_profile_id,
          status,
          run_config
        )
        VALUES (
          ${shortId},
          ${input.conversationId},
          ${input.modelProfileId},
          'queued',
          (${JSON.stringify(input.runConfig)}::text)::jsonb
        )
        RETURNING *
      `,
      );
      // Queue acceptance already recorded the user's interaction time.
      if (!input.queuedMessageId) await tx`UPDATE ai.conversations SET done = CASE WHEN done IS TRUE THEN NULL ELSE done END, last_used_at = now() WHERE id = ${input.conversationId}::uuid`;
      const turn = rowToTurn(turnRows[0]!);
      const attachedFiles = input.runConfig.files?.attached ?? [];
      for (const file of attachedFiles) {
        const copied = input.queuedMessageId
          ? await tx<{path:string}[]>`INSERT INTO ai.turn_files(turn_id,path,bytes,media_type,size,origin,dictation_recorded_at,updated_at,version)
              SELECT ${turn.id}::uuid,path,bytes,media_type,size,origin,dictation_recorded_at,updated_at,version FROM ai.queued_message_files
              WHERE message_id = ${input.queuedMessageId}::uuid AND path = ${file.path} RETURNING path`
          : input.retrySourceTurnId
          ? await tx<{ path: string }[]>`
          INSERT INTO ai.turn_files (turn_id, path, bytes, media_type, size, origin, dictation_recorded_at, updated_at, version)
          SELECT ${turn.id}::uuid, path, bytes, media_type, size, origin, dictation_recorded_at, updated_at, version
          FROM ai.turn_files
          WHERE turn_id = ${input.retrySourceTurnId}::uuid
            AND path = ${file.path}
            AND size = ${file.size}
            AND media_type = ${file.mediaType}
            AND version = ${file.version ?? -1}
          RETURNING path
        `
          : await tx<{ path: string }[]>`
          INSERT INTO ai.turn_files (turn_id, path, bytes, media_type, size, origin, dictation_recorded_at, updated_at, version)
          SELECT ${turn.id}::uuid, path, bytes, media_type, size, origin, dictation_recorded_at, updated_at, version
          FROM ai.files
          WHERE conversation_id = ${input.conversationId}::uuid
            AND path = ${file.path}
            AND size = ${file.size}
            AND media_type = ${file.mediaType}
            AND version = ${file.version ?? -1}
          RETURNING path
        `;
        if (!copied[0]) throw new Error(`Attached conversation file changed before the turn was submitted: ${file.path}`);
      }
      const messageRow = await insertMessageLocked(
        {
          conversationId: input.conversationId,
          message: input.userMessage,
          loopId: turn.id,
          meta: input.expectedDraftRevision === undefined ? undefined : { submittedDraftRevision: input.expectedDraftRevision },
        },
        tx,
      );
      const resources = [
        ...new Map((input.resources ?? []).map((resource) => [`${resource.ref.type}\0${resource.ref.id}`, resource])).values(),
      ];
      for (const resource of resources) {
        await tx`
          INSERT INTO ai.conversation_resource_refs (
            conversation_id, resource_type, resource_id, title, preview, icon, href, source_turn_id
          ) VALUES (
            ${input.conversationId}, ${resource.ref.type}, ${resource.ref.id}, ${resource.title ?? null},
            ${resource.preview ?? null}, ${resource.icon ?? null}, ${resource.href ?? null}, ${turn.id}
          )
          ON CONFLICT (conversation_id, resource_type, resource_id)
          DO UPDATE SET
            title = COALESCE(EXCLUDED.title, ai.conversation_resource_refs.title),
            preview = COALESCE(EXCLUDED.preview, ai.conversation_resource_refs.preview),
            icon = COALESCE(EXCLUDED.icon, ai.conversation_resource_refs.icon),
            href = COALESCE(EXCLUDED.href, ai.conversation_resource_refs.href),
            source_turn_id = EXCLUDED.source_turn_id,
            last_seen_at = now()
        `;
      }
      if (input.expectedDraftRevision !== undefined) {
        await tx`
          UPDATE ai.conversations
          SET draft_content = '[]'::jsonb,
              draft_revision = draft_revision + 1,
              draft_updated_at = now()
          WHERE id = ${input.conversationId}::uuid
        `;
      }
      if (input.queuedMessageId) {
        await tx`UPDATE ai.queued_messages SET status = 'submitted', submission = '{}'::jsonb, content = '[]'::jsonb WHERE id = ${input.queuedMessageId}::uuid`;
        await tx`DELETE FROM ai.queued_message_files WHERE message_id = ${input.queuedMessageId}::uuid`;
      }
      return { turn, message: rowToMessage(messageRow) };
    });
  },

  getTurnRunConfig: async (input) => {
    const rows = await sql<{ run_config: unknown }[]>`
      SELECT run_config
      FROM ai.turns
      WHERE id = ${input.turnId}::uuid
        AND conversation_id = ${input.conversationId}::uuid
      LIMIT 1
    `;
    return rows[0]?.run_config ? parseJsonValue<AiTurnRunConfig>(rows[0].run_config) : null;
  },

  getLatestTurn: async (input) => {
    const [row] = await sql<TurnRow[]>`SELECT * FROM ai.turns WHERE conversation_id = ${input.conversationId}::uuid AND NOT COALESCE(run_config ? 'background', false)
      ORDER BY created_at DESC, id DESC LIMIT 1`;
    return row ? rowToTurn(row) : null;
  },

  getTurn: async (input) => {
    const rows = await sql<TurnRow[]>`
      SELECT *
      FROM ai.turns
      WHERE id = ${input.turnId}
        AND conversation_id = ${input.conversationId}
      LIMIT 1
    `;
    return rows[0] ? rowToTurn(rows[0]) : null;
  },

  getTurnByShortId: async (input) => {
    const rows = await sql<TurnRow[]>`
      SELECT *
      FROM ai.turns
      WHERE short_id = ${input.shortId}
        AND conversation_id = ${input.conversationId}::uuid
      LIMIT 1
    `;
    return rows[0] ? rowToTurn(rows[0]) : null;
  },

  getActiveTurn: async (input) => {
    const rows = await sql<TurnRow[]>`
      SELECT *
      FROM ai.turns
      WHERE conversation_id = ${input.conversationId}
        AND NOT COALESCE(run_config ? 'background', false)
        AND status IN ('queued', 'running', 'waiting_for_action')
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (!rows[0]) return null;
    return {
      turn: rowToTurn(rows[0]),
      liveBlocks: rowToLiveBlocks(rows[0]),
      liveSeq: Number(rows[0].live_seq ?? 0),
    };
  },

  claimTurn: async (input) => {
    const leaseMs = boundedMs(input.leaseMs, 60_000, 5_000, 5 * 60_000);
    const runBudgetMs = Number.isFinite(input.runBudgetMs) && input.runBudgetMs >= 0 ? input.runBudgetMs : 30 * 60_000;
    const maxAttempts = Math.max(1, Math.floor(input.maxAttempts));
    const rows = await sql<TurnRow[]>`
      UPDATE ai.turns
      SET attempt = attempt + 1,
          status = 'running',
          lease_owner = ${input.leaseOwner},
          lease_expires_at = now() + (${leaseMs} * interval '1 millisecond'),
          heartbeat_at = now(),
          run_budget_ms = COALESCE(run_budget_ms, ${runBudgetMs}),
          deadline = CASE
            WHEN COALESCE(run_budget_ms, ${runBudgetMs}) = 0 THEN NULL
            WHEN ${input.from} = 'waiting' OR deadline IS NULL THEN now() + (COALESCE(run_budget_ms, ${runBudgetMs}) * interval '1 millisecond')
            ELSE deadline
          END
      WHERE id = ${input.turnId}
        AND conversation_id = ${input.conversationId}
        AND cancel_requested_at IS NULL
        AND attempt - (
          SELECT COUNT(*)::int
          FROM ai.pending_actions
          WHERE turn_id = ${input.turnId}
            AND conversation_id = ${input.conversationId}
            AND status = 'resolved'
        ) < ${maxAttempts}
        AND (
          (
            ${input.from} = 'queue'
            AND (
              status = 'queued'
              OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now()))
            )
          )
          OR (
            ${input.from} = 'waiting'
            AND status = 'waiting_for_action'
            AND EXISTS (
              SELECT 1
              FROM ai.pending_actions action
              WHERE action.turn_id = ${input.turnId}
                AND action.conversation_id = ${input.conversationId}
                AND action.status = 'resolved'
                AND EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(live_blocks) = 'array' THEN live_blocks ELSE '[]'::jsonb END
                  ) block
                  WHERE block->>'kind' = 'tool'
                    AND block->>'callId' = action.call_id
                    AND block->>'status' IN ('awaiting_approval', 'awaiting_client')
                )
            )
          )
        )
      RETURNING *
    `;
    if (!rows[0]) return null;
    const claim: AiTurnClaim = {
      turn: rowToTurn(rows[0]),
      runConfig: rows[0].run_config ? parseJsonValue<AiTurnRunConfig>(rows[0].run_config) : null,
      liveBlocks: rows[0].live_blocks ? rowToLiveBlocks(rows[0]) : null,
      liveSeq: Number(rows[0].live_seq ?? 0),
    };
    return claim;
  },

  heartbeatTurn: async (input) => {
    const leaseMs = boundedMs(input.leaseMs, 60_000, 5_000, 5 * 60_000);
    const rows = await sql<{ id: string }[]>`
      UPDATE ai.turns
      SET heartbeat_at = now(),
          lease_expires_at = now() + (${leaseMs} * interval '1 millisecond')
      WHERE id = ${input.turnId}
        AND conversation_id = ${input.conversationId}
        AND lease_owner = ${input.leaseOwner}
        AND status = 'running'
        AND cancel_requested_at IS NULL
        AND (deadline IS NULL OR deadline > now())
      RETURNING id
    `;
    return Boolean(rows[0]);
  },

  suspendTurn: async (input) => {
    const waitingBudgetMs = boundedMs(input.waitingBudgetMs, 24 * 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000);
    const rows = await sql<{ id: string }[]>`
      UPDATE ai.turns
      SET status = 'waiting_for_action',
          lease_owner = NULL,
          lease_expires_at = NULL,
          heartbeat_at = now(),
          live_blocks = (${JSON.stringify(input.blocks)}::text)::jsonb,
          live_seq = ${input.seq},
          deadline = now() + (${waitingBudgetMs} * interval '1 millisecond')
      WHERE id = ${input.turnId}
        AND conversation_id = ${input.conversationId}
        AND status = 'running'
        AND lease_owner = ${input.leaseOwner}
      RETURNING id
    `;
    return Boolean(rows[0]);
  },

  saveTurnLiveState: async (input) => {
    const rows = await sql<{ id: string }[]>`
      UPDATE ai.turns
      SET live_blocks = (${JSON.stringify(input.blocks)}::text)::jsonb,
          live_seq = ${input.seq}
      WHERE id = ${input.turnId}
        AND conversation_id = ${input.conversationId}
        AND status = 'running'
        AND lease_owner = ${input.leaseOwner}
      RETURNING id
    `;
    return Boolean(rows[0]);
  },

  requestTurnAbort: async (input) => {
    const reason = input.reason ?? "user";
    const rows = await sql<TurnRow[]>`
      UPDATE ai.turns
      SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
          cancellation_reason = COALESCE(cancellation_reason, ${reason})
      WHERE id = ${input.turnId}
        AND conversation_id = ${input.conversationId}
        AND status IN ('queued', 'running', 'waiting_for_action')
      RETURNING status, lease_owner, lease_expires_at, id, conversation_id, attempt, model_profile_id, created_at, completed_at, error
    `;
    if (!rows[0]) return { found: false };
    const row = rows[0];
    const ownerless = !row.lease_owner || !row.lease_expires_at || new Date(row.lease_expires_at).getTime() < Date.now();
    return { found: true, status: row.status, ownerless };
  },

  completeTurn: async (input) => {
    return sql.begin(async (tx) => {
      const turnRows = await tx<{ id: string }[]>`
        SELECT id
        FROM ai.turns
        WHERE id = ${input.turnId}
          AND conversation_id = ${input.conversationId}
          AND status IN ('queued', 'running', 'waiting_for_action')
          AND (
            (${input.leaseOwner ?? null}::text IS NOT NULL AND lease_owner = ${input.leaseOwner ?? null})
            OR (
              ${input.leaseOwner ?? null}::text IS NULL
              AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now())
            )
          )
        FOR UPDATE
      `;
      if (!turnRows[0]) return "lost" as const;

      if (input.status === "completed") {
        const pending = await tx<{ id: string }[]>`
          SELECT id
          FROM ai.turn_steers
          WHERE conversation_id = ${input.conversationId}
            AND turn_id = ${input.turnId}
            AND status = 'pending'
          LIMIT 1
        `;
        if (pending[0]) return "pending_steering" as const;
      }

      await tx`
        UPDATE ai.turns
        SET status = ${input.status},
            completed_at = now(),
            error = ${input.error ?? null},
            lease_owner = NULL,
            lease_expires_at = NULL,
            live_blocks = NULL
        WHERE id = ${input.turnId}
      `;
      await tx`
        UPDATE ai.pending_actions
        SET status = 'aborted', resolved_at = COALESCE(resolved_at, now())
        WHERE turn_id = ${input.turnId}
          AND status = 'pending'
      `;
      if (input.status !== "completed") {
        await tx`
          UPDATE ai.turn_steers
          SET status = 'discarded', consumed_at = COALESCE(consumed_at, now())
          WHERE turn_id = ${input.turnId}
            AND status = 'pending'
        `;
      }
      return "completed" as const;
    });
  },

  sweepTurns: async (input) => {
    const limit = Math.min(Math.max(Math.floor(input?.limit ?? 200), 1), 1_000);
    const maxAttempts = Math.max(1, Math.floor(input?.maxAttempts ?? 5));
    const result: AiTurnSweepResult = { requeued: [], failed: [], aborted: [] };

    // 1) Finalize turns that exhausted actual recovery attempts. Resuming a
    // resolved user/frontend action is normal progress and does not consume
    // this budget.
    const exhaustedRows = await sql<{ id: string; conversation_id: string; error: string; attempt: number; live_seq: number | string }[]>`
      UPDATE ai.turns
      SET status = 'failed',
          completed_at = now(),
          error = 'AI turn exhausted its recovery attempts.',
          lease_owner = NULL,
          lease_expires_at = NULL,
          live_blocks = NULL
      WHERE id IN (
        SELECT turn_row.id
        FROM ai.turns turn_row
        WHERE turn_row.cancel_requested_at IS NULL
          AND (turn_row.lease_owner IS NULL OR turn_row.lease_expires_at IS NULL OR turn_row.lease_expires_at < now())
          AND turn_row.attempt - (
            SELECT COUNT(*)::int
            FROM ai.pending_actions action
            WHERE action.turn_id = turn_row.id
              AND action.conversation_id = turn_row.conversation_id
              AND action.status = 'resolved'
          ) >= ${maxAttempts}
          AND (
            turn_row.status = 'queued'
            OR (turn_row.status = 'running' AND (turn_row.lease_expires_at IS NULL OR turn_row.lease_expires_at < now()))
            OR (
              turn_row.status = 'waiting_for_action'
              AND EXISTS (
                SELECT 1
                FROM ai.pending_actions action
                WHERE action.turn_id = turn_row.id
                  AND action.conversation_id = turn_row.conversation_id
                  AND action.status = 'resolved'
                  AND EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(
                      CASE
                        WHEN jsonb_typeof(turn_row.live_blocks) = 'array' THEN turn_row.live_blocks
                        ELSE '[]'::jsonb
                      END
                    ) block
                    WHERE block->>'kind' = 'tool'
                      AND block->>'callId' = action.call_id
                      AND block->>'status' IN ('awaiting_approval', 'awaiting_client')
                  )
              )
            )
          )
        LIMIT ${limit}
      )
      RETURNING id, conversation_id, error, attempt, live_seq
    `;

    // 2) Finalize over-budget turns without a live lease.
    const budgetRows = await sql<{ id: string; conversation_id: string; error: string; attempt: number; live_seq: number | string }[]>`
      UPDATE ai.turns
      SET status = 'failed',
          completed_at = now(),
          error = 'Run time limit reached. You can continue the task in a new message.',
          lease_owner = NULL,
          lease_expires_at = NULL,
          live_blocks = NULL
      WHERE id IN (
        SELECT id FROM ai.turns
        WHERE status IN ('queued', 'running')
          AND (
            (deadline IS NOT NULL AND deadline < now())
            OR (status = 'queued' AND deadline IS NULL AND created_at < now() - (${SWEEP_DEAD_QUEUED_MS} * interval '1 millisecond'))
          )
          AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now())
        LIMIT ${limit}
      )
      RETURNING id, conversation_id, error, attempt, live_seq
    `;
    result.failed = [...exhaustedRows, ...budgetRows].map((row) => ({
      conversationId: row.conversation_id,
      turnId: row.id,
      error: row.error,
      attempt: Number(row.attempt),
      seq: Number(row.live_seq) + 1,
    }));

    // 3) Finalize aborts: cancel-requested turns without a live lease, and expired waits.
    const abortedRows = await sql<{ id: string; conversation_id: string; attempt: number; live_seq: number | string }[]>`
      UPDATE ai.turns
      SET status = 'aborted',
          completed_at = now(),
          cancellation_reason = COALESCE(cancellation_reason, 'sweep'),
          lease_owner = NULL,
          lease_expires_at = NULL,
          live_blocks = NULL
      WHERE id IN (
        SELECT id FROM ai.turns
        WHERE status IN ('queued', 'running', 'waiting_for_action')
          AND (
            (cancel_requested_at IS NOT NULL AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now()))
            OR (status = 'waiting_for_action' AND deadline IS NOT NULL AND deadline < now())
          )
        LIMIT ${limit}
      )
      RETURNING id, conversation_id, attempt, live_seq
    `;
    result.aborted = abortedRows.map((row) => ({
      conversationId: row.conversation_id,
      turnId: row.id,
      attempt: Number(row.attempt),
      seq: Number(row.live_seq) + 1,
    }));

    for (const finalized of [...result.failed, ...result.aborted]) {
      await sql`
        UPDATE ai.pending_actions
        SET status = 'aborted', resolved_at = COALESCE(resolved_at, now())
        WHERE turn_id = ${finalized.turnId}
          AND status = 'pending'
      `;
      await sql`
        UPDATE ai.turn_steers
        SET status = 'discarded', consumed_at = COALESCE(consumed_at, now())
        WHERE turn_id = ${finalized.turnId}
          AND status = 'pending'
      `;
    }

    // 4) Requeue crashed running turns (lease expired, still within budget).
    const requeuedRows = await sql<{ id: string; conversation_id: string }[]>`
      UPDATE ai.turns
      SET status = 'queued',
          lease_owner = NULL,
          lease_expires_at = NULL
      WHERE id IN (
        SELECT id FROM ai.turns
        WHERE status = 'running'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < now()
          AND cancel_requested_at IS NULL
          AND (deadline IS NULL OR deadline > now())
        LIMIT ${limit}
      )
      RETURNING id, conversation_id
    `;

    // 5) Stale queued turns whose queue message may be lost — re-enqueue them too.
    const staleQueuedRows = await sql<{ id: string; conversation_id: string }[]>`
      SELECT id, conversation_id
      FROM ai.turns
      WHERE status = 'queued'
        AND cancel_requested_at IS NULL
        AND created_at < now() - (${SWEEP_STALE_QUEUED_MS} * interval '1 millisecond')
        AND (heartbeat_at IS NULL OR heartbeat_at < now() - (${SWEEP_STALE_QUEUED_MS} * interval '1 millisecond'))
      LIMIT ${limit}
    `;

    // 6) A durable action response can outlive the queue message that was meant
    // to resume it. Re-enqueue exactly the action still shown as awaiting in the
    // turn snapshot; historical responses must not unlock a later action.
    const resumableWaitingRows = await sql<{ id: string; conversation_id: string }[]>`
      SELECT turn_row.id, turn_row.conversation_id
      FROM ai.turns turn_row
      WHERE turn_row.status = 'waiting_for_action'
        AND turn_row.cancel_requested_at IS NULL
        AND (turn_row.deadline IS NULL OR turn_row.deadline > now())
        AND turn_row.attempt - (
          SELECT COUNT(*)::int
          FROM ai.pending_actions action
          WHERE action.turn_id = turn_row.id
            AND action.conversation_id = turn_row.conversation_id
            AND action.status = 'resolved'
        ) < ${maxAttempts}
        AND EXISTS (
          SELECT 1
          FROM ai.pending_actions action
          WHERE action.turn_id = turn_row.id
            AND action.conversation_id = turn_row.conversation_id
            AND action.status = 'resolved'
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(turn_row.live_blocks) = 'array' THEN turn_row.live_blocks
                  ELSE '[]'::jsonb
                END
              ) block
              WHERE block->>'kind' = 'tool'
                AND block->>'callId' = action.call_id
                AND block->>'status' IN ('awaiting_approval', 'awaiting_client')
            )
        )
      LIMIT ${limit}
    `;

    const requeueIds = new Set<string>();
    for (const row of [...requeuedRows, ...staleQueuedRows, ...resumableWaitingRows]) {
      if (requeueIds.has(row.id)) continue;
      requeueIds.add(row.id);
      result.requeued.push({ conversationId: row.conversation_id, turnId: row.id });
    }

    return result;
  },

  savePendingTurnAction: async (input) => {
    await sql`
      INSERT INTO ai.pending_actions (
        turn_id,
        conversation_id,
        call_id,
        kind,
        tool_name,
        args,
        message,
        review,
        approval_scope,
        allow_always,
        frontend_mode,
        status,
        resolved_event,
        resolved_at
      )
      VALUES (
        ${input.turnId},
        ${input.conversationId},
        ${input.callId},
        ${input.kind},
        ${input.name},
        ${JSON.stringify(input.args ?? null)}::text::jsonb,
        ${input.message ?? null},
        ${input.review ? JSON.stringify(input.review) : null}::text::jsonb,
        ${input.approvalScope},
        ${input.allowAlways},
        ${input.frontendMode ?? null},
        ${input.resolvedEvent ? "resolved" : "pending"},
        ${input.resolvedEvent ? JSON.stringify(input.resolvedEvent) : null}::text::jsonb,
        CASE WHEN ${Boolean(input.resolvedEvent)} THEN now() ELSE NULL END
      )
      ON CONFLICT (turn_id, call_id)
      DO UPDATE SET
        kind = EXCLUDED.kind,
        tool_name = EXCLUDED.tool_name,
        args = EXCLUDED.args,
        message = EXCLUDED.message,
        review = EXCLUDED.review,
        approval_scope = EXCLUDED.approval_scope,
        allow_always = EXCLUDED.allow_always,
        frontend_mode = EXCLUDED.frontend_mode
    `;
  },

  listPendingTurnActions: async (input) => {
    const rows = await sql<PendingActionRow[]>`
      SELECT *
      FROM ai.pending_actions
      WHERE conversation_id = ${input.conversationId}
        AND turn_id = ${input.turnId}
        AND status = 'pending'
      ORDER BY created_at ASC
    `;
    return rows.map(pendingActionToPublicEvent);
  },

  getPendingTurnAction: async (input) => {
    const rows = await sql<PendingActionRow[]>`
      SELECT *
      FROM ai.pending_actions
      WHERE conversation_id = ${input.conversationId}
        AND turn_id = ${input.turnId}
        AND call_id = ${input.callId}
      LIMIT 1
    `;
    return rows[0] ? rowToPendingActionRecord(rows[0]) : null;
  },

  listPendingActionRecords: async (input) => {
    const rows = await sql<PendingActionRow[]>`
      SELECT *
      FROM ai.pending_actions
      WHERE conversation_id = ${input.conversationId}
        AND turn_id = ${input.turnId}
        AND status = 'pending'
      ORDER BY created_at ASC
    `;
    return rows.map(rowToPendingActionRecord);
  },

  listResolvedPendingActions: async (input) => {
    const rows = await sql<PendingActionRow[]>`
      SELECT *
      FROM ai.pending_actions
      WHERE conversation_id = ${input.conversationId}
        AND turn_id = ${input.turnId}
        AND status = 'resolved'
      ORDER BY created_at ASC
    `;
    return rows.map(rowToPendingActionRecord);
  },

  resolvePendingTurnAction: async (input) => {
    const rows = await sql<PendingActionRow[]>`
      UPDATE ai.pending_actions
      SET status = 'resolved',
          resolved_event = ${JSON.stringify(input.event)}::text::jsonb,
          resolved_at = now()
      WHERE conversation_id = ${input.conversationId}
        AND turn_id = ${input.turnId}
        AND call_id = ${input.callId}
        AND status = 'pending'
      RETURNING *
    `;
    return rows[0] ? rowToPendingActionRecord(rows[0]) : null;
  },

  clearPendingTurnActions: async (input) => {
    await sql`
      UPDATE ai.pending_actions
      SET status = 'aborted',
          resolved_at = COALESCE(resolved_at, now())
      WHERE conversation_id = ${input.conversationId}
        AND turn_id = ${input.turnId}
        AND status = 'pending'
    `;
  },

  enqueueTurnSteer: async (input) =>
    sql.begin(async (tx) => {
      const turnRows = await tx<TurnRow[]>`
        SELECT *
        FROM ai.turns
        WHERE id = ${input.turnId}
          AND conversation_id = ${input.conversationId}
        FOR UPDATE
      `;
      const turn = turnRows[0];
      if (!turn) return { ok: false, reason: "not_found" as const };
      const runConfig = turn.run_config ? parseJsonValue<AiTurnRunConfig>(turn.run_config) : null;
      if (runConfig?.kind === "compact") return { ok: false, reason: "not_chat" as const };
      if (!(["queued", "running", "waiting_for_action"] as AiTurnStatus[]).includes(turn.status)) {
        return { ok: false, reason: "not_active" as const };
      }

      const existing = await tx<TurnSteerRow[]>`
        SELECT *
        FROM ai.turn_steers
        WHERE turn_id = ${input.turnId}
          AND client_request_id = ${input.clientRequestId}
        LIMIT 1
      `;
      if (existing[0]) return { ok: true, steer: rowToTurnSteer(existing[0]) };

      const rows = await tx<TurnSteerRow[]>`
        INSERT INTO ai.turn_steers (conversation_id, turn_id, seq, client_request_id, text)
        VALUES (
          ${input.conversationId},
          ${input.turnId},
          (SELECT COALESCE(MAX(seq), 0) + 1 FROM ai.turn_steers WHERE turn_id = ${input.turnId}),
          ${input.clientRequestId},
          ${input.text}
        )
        RETURNING *
      `;
      return { ok: true, steer: rowToTurnSteer(rows[0]!) };
    }),

  listTurnSteers: async (input) => {
    const rows = await sql<TurnSteerRow[]>`
      SELECT *
      FROM ai.turn_steers
      WHERE conversation_id = ${input.conversationId}
        AND turn_id = ${input.turnId}
      ORDER BY seq ASC
    `;
    return rows.map(rowToTurnSteer);
  },

  takePendingTurnSteers: async (input) =>
    sql.begin(async (tx) => {
      const owner = await tx<{ id: string }[]>`
        SELECT id
        FROM ai.turns
        WHERE id = ${input.turnId}
          AND conversation_id = ${input.conversationId}
          AND status = 'running'
          AND lease_owner = ${input.leaseOwner}
          AND cancel_requested_at IS NULL
          AND lease_expires_at > now()
        FOR UPDATE
      `;
      if (!owner[0]) throw new Error("AI turn lost its lease while taking steering.");

      const pending = await tx<TurnSteerRow[]>`
        SELECT *
        FROM ai.turn_steers
        WHERE conversation_id = ${input.conversationId}
          AND turn_id = ${input.turnId}
          AND status = 'pending'
        ORDER BY seq ASC
        FOR UPDATE
      `;
      if (pending.length === 0) return [];

      await tx`SELECT id FROM ai.conversations WHERE id = ${input.conversationId} FOR UPDATE`;
      const consumed: AiTurnSteer[] = [];
      for (const steer of pending) {
        const message = await insertMessageLocked(
          {
            conversationId: input.conversationId,
            message: { role: "user", content: [{ type: "text", text: steer.text }] },
            loopId: input.turnId,
            meta: { steerId: steer.id },
          },
          tx,
        );
        const rows = await tx<TurnSteerRow[]>`
          UPDATE ai.turn_steers
          SET status = 'consumed', message_id = ${message.id}, consumed_at = now()
          WHERE id = ${steer.id}
            AND status = 'pending'
          RETURNING *
        `;
        if (rows[0]) consumed.push(rowToTurnSteer(rows[0]));
      }
      return consumed;
    }),

  createSessionStore: (input): SessionStore => ({
    load: async (): Promise<StoreEntry[]> => {
      // The loop must only ever see the active model context, never archived history.
      if (input.background && input.turnId) {
        const own = await aiConversations.listTurnMessages({ conversationId: input.conversationId, loopId: input.turnId });
        const context = input.background.context;
        return [...context, ...own.map(row => ({ seq: context.length + row.seq, kind: row.kind, message: row.message }))];
      }
      // Results delivered after this turn started belong to the next turn's context.
      // Compare durable message sequences rather than wall-clock timestamps.
      const rows = input.turnId
        ? (await sql<MessageRow[]>`
            SELECT * FROM ai.messages
            WHERE conversation_id = ${input.conversationId}::uuid AND compacted_at IS NULL
              AND ${visibleToTurn(input.turnId)}
            ORDER BY seq ASC
          `).map(rowToMessage)
        : await aiConversations.listContextMessages({ conversationId: input.conversationId });
      return rows.map((row) => ({
        seq: row.seq,
        kind: row.kind,
        message:
          input.turnInput !== undefined && input.turnId === row.loopId && row.message.role === "user" && !row.meta?.steerId
            ? {
                role: "user" as const,
                content:
                  typeof input.turnInput === "string"
                    ? [{ type: "text" as const, text: input.turnInput }]
                    : input.turnInput.map((part) => (typeof part === "string" ? { type: "text" as const, text: part } : part)),
              }
            : row.message,
      }));
    },
    append: async (message, opts) => {
      // Initial input and durable steering are already persisted transactionally before Nessi appends them.
      if (message.role === "user") return;
      const meta = toolMessageMeta(message, input.toolPresentations, input.rejectedToolCallIds);

      if (input.turnId && input.leaseOwner) {
        const appended = await appendTurnOwnedMessage({
          background: Boolean(input.background),
          conversationId: input.conversationId,
          turnId: input.turnId,
          leaseOwner: input.leaseOwner,
          message,
          kind: opts?.kind,
          seq: opts?.seq,
          loopId: opts?.kind === "summary" && !input.background ? null : input.turnId,
          modelProfileId: input.modelProfileId,
          meta,
        });
        if (!appended) {
          throw new Error("AI turn lost its lease while writing a message.");
        }
        await input.onMessage?.(appended);
        return;
      }

      await sql.begin(async (tx) => {
        await tx`SELECT id FROM ai.conversations WHERE id = ${input.conversationId} FOR UPDATE`;
        await insertMessageLocked(
          {
            conversationId: input.conversationId,
            message,
            kind: opts?.kind,
            seq: opts?.seq,
            loopId: input.turnId && opts?.kind !== "summary" ? input.turnId : null,
            modelProfileId: input.modelProfileId,
            meta,
          },
          tx,
        );
      });
    },
  }),
};
