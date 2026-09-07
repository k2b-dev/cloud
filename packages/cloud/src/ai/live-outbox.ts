import type { sql } from "bun";
import { lazySync } from "../_internal/process-sync";
import { createPgOutbox } from "../services/outbox";
import { toPgTextArray } from "../services/postgres";
import { latestTopicCursor } from "../services/topic-cursor";
import type { AiInvalidation, AiInvalidationDomain } from "./live-events";

const RETENTION_MS = 24 * 60 * 60 * 1_000;
const RECONCILE_INTERVAL_MS = 1_000;
const MAX_ATTEMPTS = 20;

type SqlClient = typeof sql;

export type AiLiveOutboxRow = {
  id: string;
  change_id: string;
  audience_user_id: string;
  conversation_short_id: string | null;
  project_short_id: string | null;
  domains: AiInvalidationDomain[];
  attempts: number;
  created_at: Date | string;
};

const invalidationTopic = lazySync((sync) =>
  sync.topic<AiInvalidation>({
    id: "cloud-ai-invalidations",
    owner: "cloud",
    retention: { maxAgeMs: RETENTION_MS, maxBytes: 64 * 1024 * 1024 },
    maxPayloadBytes: 9_024,
  }),
);

const tenantId = (userId: string): string => userId;

export const enqueueAiInvalidation = async (
  db: SqlClient,
  input: {
    audienceUserId: string;
    domains: AiInvalidationDomain[];
    conversationId?: string | null;
    projectId?: string | null;
    changeId?: string;
  },
): Promise<string> => {
  const [row] = await db<{ id: string }[]>`
    INSERT INTO ai.live_invalidation_outbox (
      change_id, audience_user_id, conversation_short_id, project_short_id, domains
    )
    VALUES (
      ${input.changeId ?? crypto.randomUUID()}::uuid,
      ${input.audienceUserId}::uuid,
      ${input.conversationId ?? null},
      ${input.projectId ?? null},
      ${toPgTextArray([...new Set(input.domains)])}::text[]
    )
    RETURNING id::text
  `;
  if (!row) throw new Error("AI live invalidation insert returned no id");
  return row.id;
};

const publishAiInvalidation = (row: AiLiveOutboxRow): Promise<unknown> => {
  const event: AiInvalidation = {
    type: "ai.invalidated",
    changeId: row.change_id,
    conversationId: row.conversation_short_id,
    projectId: row.project_short_id,
    domains: row.domains,
    at: new Date(row.created_at).toISOString(),
  };
  return invalidationTopic().publish({
    tenantId: tenantId(row.audience_user_id),
    orderingKey: row.conversation_short_id ?? row.project_short_id ?? row.audience_user_id,
    idempotencyKey: row.change_id,
    data: event,
  });
};

const outbox = createPgOutbox<AiLiveOutboxRow>({
  table: "ai.live_invalidation_outbox",
  name: "ai:live-outbox",
  publish: publishAiInvalidation,
  reconcileIntervalMs: RECONCILE_INTERVAL_MS,
  orderBy: "audience_user_id",
  maxAttempts: MAX_ATTEMPTS,
});

export const claimAiInvalidationBatch = outbox.claim;
export const dispatchAiInvalidation = outbox.dispatch;
export const reconcileAiInvalidations = outbox.reconcile;
export const notifyAiInvalidations = outbox.notify;
export const startAiInvalidationRuntime = outbox.start;
export const stopAiInvalidationRuntime = outbox.stop;

export const liveAiInvalidations = (input: { userId: string; after?: string | null; signal?: AbortSignal }) =>
  invalidationTopic()
    .hub({ tenantId: tenantId(input.userId) })
    .subscribe({ after: input.after ?? undefined, signal: input.signal });

export const latestAiInvalidationCursor = (userId: string): Promise<string> =>
  latestTopicCursor({ topic: invalidationTopic(), resourceId: "cloud-ai-invalidations", tenantId: tenantId(userId) });
