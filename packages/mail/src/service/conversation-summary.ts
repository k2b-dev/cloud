import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { ActorRef, UpdateConversationSummary } from "../contracts";
import type { MailRequestContext } from "./auth";
import { insertActivity, requireMailboxCollaborationPermission } from "./collaboration";
import { type MailActivityChange, mailLive } from "./live";

type SqlClient = typeof sql;

export type ConversationContentSummary = {
  summary: string | null;
  summaryRevision: number;
  conversationRevision: number;
};

type SummaryRow = {
  summary: string | null;
  summary_revision: string | number;
  revision: string | number;
};

export type ConversationSummaryMutation = {
  value: ConversationContentSummary;
  event: MailActivityChange | null;
};

const mapSummary = (row: SummaryRow): ConversationContentSummary => ({
  summary: row.summary,
  summaryRevision: Number(row.summary_revision),
  conversationRevision: Number(row.revision),
});

const loadSummary = async (params: {
  db: SqlClient;
  mailboxId: string;
  conversationId: string;
  lock?: boolean;
}): Promise<SummaryRow | null> => {
  const rows = params.lock
    ? await params.db<SummaryRow[]>`
        SELECT summary, summary_revision, revision
        FROM mail.conversations
        WHERE id = ${params.conversationId}::uuid
          AND mailbox_id = ${params.mailboxId}::uuid
        FOR UPDATE
      `
    : await params.db<SummaryRow[]>`
        SELECT summary, summary_revision, revision
        FROM mail.conversations
        WHERE id = ${params.conversationId}::uuid
          AND mailbox_id = ${params.mailboxId}::uuid
      `;
  return rows[0] ?? null;
};

export const getConversationSummary = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  db?: SqlClient;
}): Promise<Result<ConversationContentSummary>> => {
  const db = params.db ?? sql;
  const allowed = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read", db);
  if (!allowed.ok) return allowed;
  const summary = await loadSummary({ ...params, db });
  return summary ? ok(mapSummary(summary)) : fail(err.notFound("Conversation"));
};

const applyConversationSummaryInTransaction = async (params: {
  context: MailRequestContext | null;
  actorOverride?: ActorRef;
  mailboxId: string;
  conversationId: string;
  input: UpdateConversationSummary;
  db: SqlClient;
  activityMetadata?: Record<string, unknown>;
}): Promise<Result<ConversationSummaryMutation>> => {
  const current = await loadSummary({ ...params, lock: true });
  if (!current) return fail(err.notFound("Conversation"));
  if (Number(current.summary_revision) !== params.input.expectedSummaryRevision) {
    return fail(err.conflict("Conversation summary was changed by another collaborator"));
  }
  if (current.summary === params.input.summary) return ok({ value: mapSummary(current), event: null });

  const [updated] = await params.db<SummaryRow[]>`
    UPDATE mail.conversations
    SET
      summary = ${params.input.summary},
      summary_revision = summary_revision + 1,
      revision = revision + 1
    WHERE id = ${params.conversationId}::uuid
      AND mailbox_id = ${params.mailboxId}::uuid
    RETURNING summary, summary_revision, revision
  `;
  if (!updated) return fail(err.internal("Updated conversation summary could not be loaded"));
  const value = mapSummary(updated);
  const activityId = await insertActivity({
    db: params.db,
    mailboxId: params.mailboxId,
    conversationId: params.conversationId,
    context: params.context,
    actorOverride: params.actorOverride,
    action: "conversation.summary_updated",
    targetType: "conversation",
    targetId: params.conversationId,
    metadata: {
      ...params.activityMetadata,
      before: {
        present: current.summary !== null,
        length: current.summary?.length ?? 0,
        summaryRevision: Number(current.summary_revision),
      },
      after: {
        present: value.summary !== null,
        length: value.summary?.length ?? 0,
        summaryRevision: value.summaryRevision,
        conversationRevision: value.conversationRevision,
      },
    },
  });
  return ok({
    value,
    event: {
      mailboxId: params.mailboxId,
      conversationId: params.conversationId,
      reason: "summary",
      targetId: params.conversationId,
      activityId,
    },
  });
};

export const updateConversationSummaryInTransaction = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  input: UpdateConversationSummary;
  db: SqlClient;
  actorOverride?: ActorRef;
  activityMetadata?: Record<string, unknown>;
}): Promise<Result<ConversationSummaryMutation>> => {
  const allowed = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "write", params.db);
  return allowed.ok ? applyConversationSummaryInTransaction(params) : allowed;
};

export const updateWorkflowConversationSummaryInTransaction = async (params: {
  mailboxId: string;
  workflowVersionId: string;
  conversationId: string;
  input: UpdateConversationSummary;
  db: SqlClient;
  activityMetadata?: Record<string, unknown>;
}): Promise<Result<ConversationSummaryMutation>> =>
  applyConversationSummaryInTransaction({
    ...params,
    context: null,
    actorOverride: { kind: "workflow", workflowVersionId: params.workflowVersionId },
  });

export const updateConversationSummary = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  input: UpdateConversationSummary;
}): Promise<Result<ConversationContentSummary>> => {
  try {
    const result = await sql.begin((db) => updateConversationSummaryInTransaction({ ...params, db }));
    if (!result.ok) return result;
    if (result.data.event) mailLive.wake();
    return ok(result.data.value);
  } catch {
    return fail(err.internal("Failed to update conversation summary"));
  }
};
