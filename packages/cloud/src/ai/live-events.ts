import { z } from "zod";
import type { AiStreamEvent } from "./protocol";

export const AI_INVALIDATION_DOMAINS = [
  "conversation-list",
  "conversation-detail",
  "conversation-sources",
  "conversation-files",
  "conversation-tasks",
  "project-list",
  "project-detail",
  "project-context",
] as const;

export const AiInvalidationDomainSchema = z.enum(AI_INVALIDATION_DOMAINS);
export type AiInvalidationDomain = z.infer<typeof AiInvalidationDomainSchema>;

export const AiResourceIdSchema = z.string().regex(/^[0-9A-Za-z]{6}$/);
export const AiLiveCursorSchema = z.string().regex(/^\d+-\d+$/);

export const AiInvalidationSchema = z
  .object({
    type: z.literal("ai.invalidated"),
    changeId: z.uuid(),
    conversationId: AiResourceIdSchema.nullable(),
    projectId: AiResourceIdSchema.nullable(),
    domains: z.array(AiInvalidationDomainSchema).min(1),
    at: z.string().datetime(),
  })
  .strict();

export type AiInvalidation = z.infer<typeof AiInvalidationSchema>;

export const AI_LIVE_WS_TYPE = {
  subscribe: "ai.live.subscribe",
  ready: "ai.live.ready",
  event: "ai.live.event",
  scopeChanged: "ai.live.scope_changed",
  revoked: "ai.live.revoked",
  error: "ai.live.error",
  turnSubscribe: "ai.turn.subscribe",
  turnUnsubscribe: "ai.turn.unsubscribe",
  turnEvent: "ai.turn.event",
  turnError: "ai.turn.error",
} as const;

const AiLiveSubscribeMessageSchema = z
  .object({
    type: z.literal(AI_LIVE_WS_TYPE.subscribe),
    payload: z.object({ fromCursor: AiLiveCursorSchema.nullable(), recover: z.boolean() }).strict(),
  })
  .strict();

const AiTurnSubscribeMessageSchema = z
  .object({
    type: z.literal(AI_LIVE_WS_TYPE.turnSubscribe),
    payload: z.object({ conversationId: AiResourceIdSchema }).strict(),
  })
  .strict();

const AiTurnUnsubscribeMessageSchema = z
  .object({
    type: z.literal(AI_LIVE_WS_TYPE.turnUnsubscribe),
    payload: z.object({ conversationId: AiResourceIdSchema }).strict(),
  })
  .strict();

export const AiLiveClientMessageSchema = z.discriminatedUnion("type", [
  AiLiveSubscribeMessageSchema,
  AiTurnSubscribeMessageSchema,
  AiTurnUnsubscribeMessageSchema,
]);
export type AiLiveClientMessage = z.infer<typeof AiLiveClientMessageSchema>;

const AiLiveRevocationCodeSchema = z.enum(["login_required", "access_denied"]);
const AiLiveErrorCodeSchema = z.enum(["invalid_json", "invalid_message", "backpressure", "internal_error", "stream_failed"]);
const AiTurnErrorCodeSchema = z.enum(["not_found", "access_denied", "stream_failed"]);

export type AiLiveRevocationCode = z.infer<typeof AiLiveRevocationCodeSchema>;
export type AiLiveErrorCode = z.infer<typeof AiLiveErrorCodeSchema>;
export type AiTurnErrorCode = z.infer<typeof AiTurnErrorCodeSchema>;

const AiTurnBlockSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("text"), text: z.string() }).strict(),
  z.object({ id: z.string(), kind: z.literal("thinking"), text: z.string() }).strict(),
  z
    .object({
      id: z.string(),
      kind: z.literal("steer_message"),
      steerId: z.string(),
      text: z.string(),
      status: z.enum(["pending", "consumed", "failed"]),
    })
    .strict(),
  z.object({ id: z.string(), kind: z.literal("steer_applied"), steerId: z.string() }).strict(),
  z
    .object({
      id: z.string(),
      kind: z.literal("tool"),
      callId: z.string(),
      name: z.string(),
      args: z.unknown().optional(),
      status: z.enum(["running", "awaiting_approval", "awaiting_client", "completed", "failed", "rejected"]),
      result: z.unknown().optional(),
      isError: z.boolean().optional(),
      approval: z.unknown().optional(),
      frontendMode: z.enum(["client", "client_view", "client_interaction"]).optional(),
      presentation: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      kind: z.literal("compaction"),
      status: z.enum(["running", "completed", "skipped", "failed"]),
      result: z.unknown().optional(),
    })
    .strict(),
]);

const AiConversationSchema = z
  .object({
    id: AiResourceIdSchema,
    shortId: AiResourceIdSchema,
    title: z.string(),
    titleSource: z.enum(["default", "auto", "user"]),
    description: z.string(),
    descriptionSource: z.enum(["default", "auto", "user"]),
    keywords: z.array(z.string()),
    pinnedAt: z.string().nullable(),
    archivedAt: z.string().nullable(),
    runStatus: z.enum(["idle", "queued", "running", "needs_attention", "failed"]),
    runError: z.string().nullable(),
    unreadCompletion: z.boolean(),
    projectId: z.string().nullable(),
    draft: z.object({ content: z.array(z.unknown()), revision: z.number().int(), updatedAt: z.string().nullable() }).strict(),
    createdByUserId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const AiStoredMessageSchema = z
  .object({
    id: AiResourceIdSchema,
    shortId: AiResourceIdSchema,
    conversationId: AiResourceIdSchema,
    seq: z.number().int().nonnegative(),
    kind: z.enum(["message", "summary"]),
    message: z.unknown(),
    loopId: AiResourceIdSchema.nullable(),
    modelProfileId: z.string().nullable(),
    providerModel: z.string().nullable(),
    usage: z.unknown().nullable(),
    stopReason: z.string().nullable(),
    loopAggregate: z.unknown().nullable(),
    loopDoneReason: z.string().nullable(),
    compactedAt: z.string().nullable(),
    meta: z.unknown().nullable(),
    createdAt: z.string(),
  })
  .strict();

const AiTurnSnapshotSchema = z
  .object({
    turnId: AiResourceIdSchema,
    attempt: z.number().int().nonnegative(),
    status: z.enum(["queued", "running", "waiting_for_action", "completed", "failed", "aborted"]),
    seq: z.number().int().nonnegative(),
    blocks: z.array(AiTurnBlockSchema),
    modelProfileId: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();

const AiWireEventBaseSchema = {
  v: z.literal(1),
  conversationId: AiResourceIdSchema,
  turnId: AiResourceIdSchema,
  attempt: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
} as const;

const AiStreamEventWireSchema = z.union([
  z
    .object({
      type: z.literal("state"),
      conversation: AiConversationSchema,
      messages: z.array(AiStoredMessageSchema),
      hasMoreMessages: z.boolean().optional(),
      activeTurn: AiTurnSnapshotSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...AiWireEventBaseSchema,
      type: z.literal("turn_started"),
      modelProfileId: z.string(),
      providerModel: z.string(),
      blocks: z.array(AiTurnBlockSchema).optional(),
    })
    .strict(),
  z.object({ ...AiWireEventBaseSchema, type: z.literal("block_set"), block: AiTurnBlockSchema }).strict(),
  z
    .object({
      ...AiWireEventBaseSchema,
      type: z.literal("block_delta"),
      blockId: z.string(),
      blockKind: z.enum(["text", "thinking"]),
      delta: z.string(),
    })
    .strict(),
  z
    .object({
      ...AiWireEventBaseSchema,
      type: z.literal("turn_finished"),
      status: z.enum(["completed", "failed", "aborted"]),
      error: z.string().nullable(),
      messages: z.array(AiStoredMessageSchema).optional(),
    })
    .strict(),
]);

export const AiStreamEventSchema = z.custom<AiStreamEvent>((value) => AiStreamEventWireSchema.safeParse(value).success);

export const AiLiveServerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal(AI_LIVE_WS_TYPE.ready),
      payload: z.object({ cursor: AiLiveCursorSchema, recovered: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal(AI_LIVE_WS_TYPE.event),
      payload: z.object({ cursor: AiLiveCursorSchema, event: AiInvalidationSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal(AI_LIVE_WS_TYPE.scopeChanged),
      payload: z.object({ at: z.string().datetime() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal(AI_LIVE_WS_TYPE.revoked),
      payload: z.object({ code: AiLiveRevocationCodeSchema, message: z.string().min(1).max(500) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal(AI_LIVE_WS_TYPE.error),
      payload: z.object({ code: AiLiveErrorCodeSchema, message: z.string().min(1).max(500) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal(AI_LIVE_WS_TYPE.turnEvent),
      payload: z.object({ conversationId: AiResourceIdSchema, event: AiStreamEventSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal(AI_LIVE_WS_TYPE.turnError),
      payload: z.object({ conversationId: AiResourceIdSchema, code: AiTurnErrorCodeSchema, message: z.string().min(1).max(500) }).strict(),
    })
    .strict(),
]);

export type AiLiveServerMessage = z.infer<typeof AiLiveServerMessageSchema>;

export const aiTurnEventMessage = (conversationId: string, event: AiStreamEvent): AiLiveServerMessage => ({
  type: AI_LIVE_WS_TYPE.turnEvent,
  payload: { conversationId, event },
});

export const parseAiLiveServerMessage = (raw: string): AiLiveServerMessage | null => {
  try {
    const parsed = AiLiveServerMessageSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    if (parsed.data.type !== AI_LIVE_WS_TYPE.turnEvent) return parsed.data;
    const eventConversationId =
      parsed.data.payload.event.type === "state" ? parsed.data.payload.event.conversation.id : parsed.data.payload.event.conversationId;
    return eventConversationId === parsed.data.payload.conversationId ? parsed.data : null;
  } catch {
    return null;
  }
};
