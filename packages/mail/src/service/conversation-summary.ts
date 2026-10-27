import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { ActorRef, UpdateConversationSummary } from "../contracts";
import { requireMailboxAccess, requireVisibleConversation } from "./access";
import { type MailRequestContext, userBackedActor } from "./auth";
import { insertActivity, requireConversationCollaborationPermission } from "./collaboration";
import { getConversationSummaryAiAvailability } from "./conversation-summary-ai";
import { type MailActivityChange, mailLive } from "./live";

type SqlClient = typeof sql;

/** Who wrote the current summary text. */
export type ConversationSummaryAuthor = { kind: "user" | "workflow"; id: string; name: string };
export type ConversationSummaryStatus = "idle" | "pending" | "writing" | "failed" | "limited";
export type ConversationSummaryFailureCode = "timeout" | "provider_unavailable" | "input_too_large" | "allowance_exhausted" | "internal";

export type ConversationContentSummary = {
  summary: string | null;
  summaryRevision: number;
  conversationRevision: number;
  /** `person` = a person wrote or edited the text; `workflow` = a rule's AI step; `manual_ai` = AI on a person's request. */
  source: "person" | "workflow" | "manual_ai" | null;
  author: ConversationSummaryAuthor | null;
  /** The current text was written by AI. */
  ai: boolean;
  generatedAt: string | null;
  coveredMessageCount: number | null;
  /** The AI saw only the newest messages that fit its input budget. */
  truncated: boolean;
  nextStep: { text: string; due: string | null } | null;
  /** Messages that arrived after the current text was written. */
  newMessagesSince: number;
  /** `pending` = bundled and waiting for its quiet period; `writing` = the AI call runs. */
  status: ConversationSummaryStatus;
  failure: {
    code: ConversationSummaryFailureCode;
    attempts: number;
    lastAttemptAt: string;
    workflow: { id: string; name: string } | null;
  } | null;
  /** Only while a rule wanted to summarize today and its daily limit stopped it. */
  limit: { scope: "rule" | "mailbox"; workflow: { id: string; name: string } | null; limit: number; resetsAt: string } | null;
  /** The viewing person's own AI allowance for a summary on request; amounts stay hidden. */
  allowance: { unlimited: boolean; usedPercent: number | null; resetsAt: string | null } | null;
  /** The viewing person may ask the AI for a summary now. */
  canGenerate: boolean;
};

export type SummaryMetadata = {
  source: ConversationContentSummary["source"];
  author: ConversationSummaryAuthor | null;
  ai: boolean;
  generatedAt: string | null;
  coveredMessageCount: number | null;
  coveredThrough: string | null;
  truncated: boolean;
  nextStep: ConversationContentSummary["nextStep"];
};

export type SummaryRow = {
  summary: string | null;
  summary_revision: string | number;
  revision: string | number;
  summary_metadata: Partial<SummaryMetadata>;
  message_count: number;
  last_message_seq: string | null;
  new_message_count: number;
  generation_status: ConversationContentSummary["status"] | null;
  generation_failure: ConversationContentSummary["failure"];
  generation_limit: ConversationContentSummary["limit"];
};

export type ConversationSummaryMutation = {
  value: ConversationContentSummary;
  event: MailActivityChange | null;
  skipped?: "edited_by_person";
};

export const mapConversationSummary = (row: SummaryRow): ConversationContentSummary => ({
  summary: row.summary,
  summaryRevision: Number(row.summary_revision),
  conversationRevision: Number(row.revision),
  source: row.summary_metadata.source ?? (row.summary === null ? null : "person"),
  author: row.summary_metadata.author ?? null,
  ai: row.summary_metadata.ai ?? false,
  generatedAt: row.summary_metadata.generatedAt ?? null,
  coveredMessageCount: row.summary_metadata.coveredMessageCount ?? null,
  truncated: row.summary_metadata.truncated ?? false,
  nextStep: row.summary_metadata.nextStep ?? null,
  newMessagesSince: row.summary === null ? 0 : row.new_message_count,
  status:
    row.generation_status === "limited" && row.generation_limit && Date.parse(row.generation_limit.resetsAt) <= Date.now()
      ? "idle"
      : (row.generation_status ?? "idle"),
  failure: row.generation_status === "failed" ? row.generation_failure : null,
  limit:
    row.generation_status === "limited" && row.generation_limit && Date.parse(row.generation_limit.resetsAt) > Date.now()
      ? row.generation_limit
      : null,
  allowance: null,
  canGenerate: false,
});

export const loadConversationSummary = async (params: {
  db: SqlClient;
  mailboxId: string;
  conversationId: string;
  lock?: boolean;
}): Promise<SummaryRow | null> => {
  // Lock only the conversation: request-row changes use the same lock order.
  if (params.lock)
    await params.db`SELECT id FROM mail.conversations
    WHERE id = ${params.conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid FOR UPDATE`;
  const [row] = await params.db<SummaryRow[]>`
    SELECT c.summary, c.summary_revision, c.revision, c.summary_metadata,
      (SELECT count(*)::int FROM mail.conversation_messages m WHERE m.conversation_id = c.id) AS message_count,
      (SELECT max(link_seq)::text FROM mail.conversation_messages m WHERE m.conversation_id = c.id) AS last_message_seq,
      (SELECT count(*)::int FROM mail.conversation_messages m WHERE m.conversation_id = c.id
        AND m.link_seq > COALESCE((c.summary_metadata->>'coveredThrough')::bigint, 0)) AS new_message_count,
      r.status AS generation_status, r.failure AS generation_failure, r.limit_info AS generation_limit
    FROM mail.conversations c LEFT JOIN mail.conversation_summary_requests r ON r.conversation_id = c.id
    WHERE c.id = ${params.conversationId}::uuid AND c.mailbox_id = ${params.mailboxId}::uuid
  `;
  return row ?? null;
};

export const getConversationSummary = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  db?: SqlClient;
}): Promise<Result<ConversationContentSummary>> => {
  const db = params.db ?? sql;
  const allowed = await requireMailboxAccess(params.context, params.mailboxId, "read", db);
  if (!allowed.ok) return allowed;
  const visible = await requireVisibleConversation(allowed.data, params.conversationId, db);
  if (!visible.ok) return visible;
  const summary = await loadConversationSummary({ ...params, db });
  if (!summary) return fail(err.notFound("Conversation"));
  const value = mapConversationSummary(summary);
  const writer = await requireConversationCollaborationPermission(params.context, params.mailboxId, params.conversationId, "write", db);
  const person = userBackedActor(params.context);
  if (person) {
    const availability = await getConversationSummaryAiAvailability({ type: "user", userId: person.id });
    value.allowance = availability.allowance;
    value.canGenerate = writer.ok && availability.canGenerate;
  }
  return ok(value);
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
  const current = await loadConversationSummary({ ...params, lock: true });
  if (!current) return fail(err.notFound("Conversation"));
  if (Number(current.summary_revision) !== params.input.expectedSummaryRevision) {
    return fail(err.conflict("Conversation summary was changed by another collaborator"));
  }
  // Even clearing a summary or accepting unchanged AI text is a person's decision.
  if (
    params.context === null &&
    (current.summary_metadata.source === "person" || (!current.summary_metadata.source && current.summary !== null))
  ) {
    return ok({ value: mapConversationSummary(current), event: null, skipped: "edited_by_person" });
  }
  const person = params.context ? userBackedActor(params.context) : null;
  const metadata: SummaryMetadata = {
    source: params.context ? "person" : "workflow",
    author: person ? { kind: "user", id: person.id, name: person.displayName } : null,
    ai: false,
    generatedAt: new Date().toISOString(),
    coveredMessageCount: current.message_count,
    coveredThrough: current.last_message_seq,
    truncated: false,
    nextStep: null,
  };
  if (current.summary === params.input.summary && current.summary_metadata.source === metadata.source)
    return ok({ value: mapConversationSummary(current), event: null });

  await params.db`
    UPDATE mail.conversations
    SET
      summary = ${params.input.summary},
      summary_metadata = ${metadata}::jsonb,
      summary_revision = summary_revision + 1,
      revision = revision + 1
    WHERE id = ${params.conversationId}::uuid
      AND mailbox_id = ${params.mailboxId}::uuid
  `;
  // In-flight output is fenced by summary_revision; pending work can finish as skipped.
  const updated = await loadConversationSummary({ ...params });
  if (!updated) return fail(err.internal("Updated conversation summary could not be loaded"));
  const value = mapConversationSummary(updated);
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
  const allowed = await requireConversationCollaborationPermission(
    params.context,
    params.mailboxId,
    params.conversationId,
    "write",
    params.db,
  );
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
    return getConversationSummary(params);
  } catch {
    return fail(err.internal("Failed to update conversation summary"));
  }
};
