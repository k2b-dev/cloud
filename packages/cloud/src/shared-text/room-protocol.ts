import { z } from "zod";

export const SHARED_TEXT_ROOM_ERROR_CODE = {
  busy: "BUSY",
  frozen: "DOCUMENT_FROZEN",
  closed: "DOCUMENT_CLOSED",
  loginRequired: "LOGIN_REQUIRED",
  sessionExpired: "SESSION_EXPIRED",
  accessDenied: "ACCESS_DENIED",
  accessRevoked: "ACCESS_REVOKED",
  notFound: "DOCUMENT_NOT_FOUND",
  invalidJson: "INVALID_JSON",
  invalidMessage: "INVALID_MESSAGE",
  invalidPayload: "INVALID_PAYLOAD",
  backpressure: "BACKPRESSURE",
  internalError: "INTERNAL_ERROR",
  resyncRequired: "RESYNC_REQUIRED",
  streamFailed: "STREAM_FAILED",
  storageExhausted: "STORAGE_EXHAUSTED",
} as const;

export type SharedTextRoomProtocol<Context = unknown> = {
  wsType: {
    replayRequest: string;
    replayReady: string;
    syncPublish: string;
    awarenessPublish: string;
    syncPush: string;
    awarenessPush: string;
    error: string;
  };
  maxSyncPayloadLength: number;
  streamCursorPattern: RegExp;
  documentId: z.ZodString;
  /** Normalize application wire keys to docId/restoreRevision at the boundary. */
  decode(packet: unknown): unknown;
  encode(type: string, payload: unknown, ctx: Context): unknown;
};

/** Canonical nonnegative Postgres bigint, used by the existing snapshot contract. */
export const SharedTextRestoreRevisionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .max(19)
  .refine((value) => /^(0|[1-9]\d*)$/.test(value) && value.length <= 19 && BigInt(value) <= 9_223_372_036_854_775_807n);

/** Same bounded JSON messages for server rooms and custom application transports. */
export const createSharedTextRoomSchemas = (protocol: Pick<SharedTextRoomProtocol, "wsType" | "maxSyncPayloadLength" | "documentId">) => {
  const ReplayRequestMessageSchema = z.object({
    type: z.literal(protocol.wsType.replayRequest),
    payload: z.object({
      docId: protocol.documentId,
      presencePeerId: z.uuid().optional(),
      fromCursor: z.string().max(256).nullable().optional(),
      restoreRevision: SharedTextRestoreRevisionSchema.nullable(),
    }),
  });
  const SyncPublishMessageSchema = z.object({
    type: z.literal(protocol.wsType.syncPublish),
    payload: z.object({
      docId: protocol.documentId,
      payload: z.string().min(1).max(protocol.maxSyncPayloadLength),
      baseCursor: z.string().max(256).nullable().optional(),
      /** Identifies a full-state retry, rather than deltas already queued before BUSY. */
      retry: z.literal(true).optional(),
      restoreRevision: SharedTextRestoreRevisionSchema,
    }),
  });
  const AwarenessPublishMessageSchema = z.object({
    type: z.literal(protocol.wsType.awarenessPublish),
    payload: z.object({
      docId: protocol.documentId,
      payload: z.string().min(1).max(256_000),
    }),
  });
  return {
    ReplayRequestMessageSchema,
    SyncPublishMessageSchema,
    AwarenessPublishMessageSchema,
    ClientMessageSchema: z.union([ReplayRequestMessageSchema, SyncPublishMessageSchema, AwarenessPublishMessageSchema]),
  };
};
