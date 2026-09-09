import { lazySync } from "@k2b/cloud";
import { createPgOutbox } from "@k2b/cloud/services/outbox";
import type { sql } from "bun";
import type { MailInvalidation } from "../live-events";

const RETENTION_MS = 24 * 60 * 60 * 1_000;
const RECONCILE_INTERVAL_MS = 15_000;

type SqlClient = typeof sql;

type LegacyConversationInvalidation = {
  mailboxId: string;
  conversationId: string;
  reason: string;
  targetId: string | null;
  activityId: string;
};

type LegacyMailboxInvalidation = {
  mailboxId: string;
  conversationId: null;
  reason: string;
  targetId: string | null;
  activityId: string;
};

export type MailConversationChangedEvent = LegacyConversationInvalidation;

export type MailMailboxChangedEvent = LegacyMailboxInvalidation;

export type MailCollaborationEvent = MailConversationChangedEvent | MailMailboxChangedEvent;

type OutboxRow = {
  id: string;
  mailbox_id: string;
  mailbox_short_id: string;
  conversation_id: string | null;
  conversation_short_id: string | null;
  attempts: number;
  created_at: Date | string;
};

const invalidationTopic = lazySync((sync) =>
  sync.topic<MailInvalidation>({
    id: "mail:invalidations",
    retention: { maxAgeMs: RETENTION_MS, maxBytes: 1024 * 1024 * 1024 },
    maxPayloadBytes: 8_000,
  }),
);

export const enqueueMailInvalidation = async (
  db: SqlClient,
  params: { mailboxId: string; conversationId?: string | null },
): Promise<string> => {
  const [row] = await db<{ id: string }[]>`
    SELECT mail.enqueue_live_invalidation(
      ${params.mailboxId}::uuid,
      ${params.conversationId ?? null}::uuid
    )::text AS id
  `;
  if (!row) throw new Error("Mail live invalidation insert returned no id");
  return row.id;
};

const publishMailInvalidation = (row: OutboxRow): Promise<unknown> => {
  const event: MailInvalidation = {
    type: "mail.invalidated",
    mailboxId: row.mailbox_short_id,
    conversationId: row.conversation_short_id,
    changeId: row.id,
    at: new Date(row.created_at).toISOString(),
  };
  // One topic-wide tenant: every subscriber tails one shared hub and filters
  // by the event's mailboxId; per-mailbox tenants would cost one whole-topic
  // follower per open mailbox per pod (tenant filtering is client-side).
  return invalidationTopic().publish({
    orderingKey: row.conversation_id ?? row.mailbox_id,
    idempotencyKey: event.changeId,
    data: event,
  });
};

const outbox = createPgOutbox<OutboxRow>({
  table: "mail.live_invalidation_outbox",
  name: "mail:events",
  publish: publishMailInvalidation,
  reconcileIntervalMs: RECONCILE_INTERVAL_MS,
});

export const claimMailInvalidationBatch = outbox.claim;
export const dispatchMailInvalidation = outbox.dispatch;
export const reconcileMailInvalidations = outbox.reconcile;
export const notifyMailInvalidations = outbox.notify;
export const startMailInvalidationRuntime = outbox.start;
export const stopMailInvalidationRuntime = outbox.stop;

// Existing domain writers already insert an activity row in the same
// transaction. Until their call sites are reduced to notifyMailInvalidations,
// these adapters only wake the durable outbox dispatcher.
export const publishMailCollaborationEvent = async (_event: LegacyConversationInvalidation): Promise<void> => notifyMailInvalidations();

export const publishMailMailboxEvent = async (_event: LegacyMailboxInvalidation): Promise<void> => notifyMailInvalidations();

/** Every mailbox's invalidations after `after`; callers filter on `data.mailboxId`. */
export const liveMailInvalidations = (params: { after?: string | null; signal?: AbortSignal }) =>
  invalidationTopic()
    .hub()
    .subscribe({
      after: params.after ?? undefined,
      signal: params.signal,
    });

/** Topic-wide head: the replay baseline for every mailbox (mailbox filtering happens on the subscriber). */
export const latestMailInvalidationCursor = (): Promise<string> => invalidationTopic().head();

export const mailInvalidationCursorSequence = (cursor: string): number => invalidationTopic().cursorSequence(cursor);
