import { z } from "zod";
import type { AiDraftContentPart } from "./types";

/**
 * Personal-chat contract: bound waiting follow-ups to 20 per chat and reject
 * overload without dropping accepted entries. Automation capacity is separate.
 */
export const AI_MESSAGE_QUEUE_LIMIT = 20;

/** Server-authored display metadata. href is projected for the current viewer. */
export const AiMessageOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), id: z.string(), name: z.string() }).strict(),
  z.object({ kind: z.literal("automation"), id: z.string(), name: z.string(), href: z.string().optional() }).strict(),
  z.object({ kind: z.literal("wakeup"), id: z.string(), name: z.string(), scheduledAt: z.iso.datetime() }).strict(),
  z.object({ kind: z.literal("chat"), id: z.string(), name: z.string(), href: z.string().optional() }).strict(),
]);
export type AiMessageOrigin = z.infer<typeof AiMessageOriginSchema>;

/** Durable provenance supplied by the platform, without display snapshots or links. */
export type AiStoredMessageOrigin =
  | { kind: "person"; id: string }
  | { kind: "automation"; id: string; runId?: string; resource?: { type: string; id: string } }
  | { kind: "wakeup"; id: string; scheduledAt: string }
  | { kind: "chat"; id: string; turnId: string };

export const AiQueuedMessageSchema = z.object({
  /** Stable entry ID and submission idempotency key; retries never allocate another ID. */
  id: z.uuid(),
  text: z.string(),
  origin: AiMessageOriginSchema,
  state: z.enum(["pending", "sending", "failed"]),
  createdAt: z.iso.datetime(),
  authorIsViewer: z.boolean(),
});
export type AiQueuedMessage = z.infer<typeof AiQueuedMessageSchema> & { content: AiDraftContentPart[] };

/** Result of POST /conversations/:id/queue/:entryId/send-now. Reconcile uncertain HTTP outcomes by entry ID. */
export type AiSendQueuedMessageResult = {
  id: string;
  state: "sending" | "submitted" | "failed";
  turnId: string | null;
  /** Only with state failed: why it was not sent (e.g. interruption_unconfirmed, cancelled); null when Send now was never requested. */
  error?: string | null;
};

/**
 * Queue changes use the existing /api/ai/live user channel: ai.invalidated,
 * conversation-detail + conversation-list. Reload the authorized queue snapshot
 * after this event; never poll. No origin or per-viewer fields travel in fanout.
 */
export type AiQueueLiveEvent = import("./live-events").AiInvalidation;
