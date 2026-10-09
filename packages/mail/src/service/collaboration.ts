import type { AccessUser, PermissionLevel } from "@k2b/cloud/server";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type {
  ActorRef,
  CreateConversationComment,
  DeleteConversationComment,
  UpdateConversationCollaboration,
  UpdateConversationComment,
} from "../contracts";
import { createConversationCommentSchema, MAIL_CONVERSATION_ASSIGNEE_LIMIT, MAIL_CONVERSATION_BATCH_LIMIT } from "../contracts";
import { withShortIdDb } from "../lib/short-id";
import { messageVisibleTo, requireMailboxAccess, requireMailboxPermission, requireVisibleConversation } from "./access";
import { projectActivityItems } from "./activity-public";
import { actorRefFromRequest, type MailRequestContext } from "./auth";
import { listCurrentMailboxUsers, listEligibleAssignees } from "./collaborators";
import { deriveReopenedConversationWorkStatus, isAutomaticSubmission } from "./conversation-work-state";
import { resolveMailExecution } from "./execution";
import { type MailActivityChange, mailLive } from "./live";
import { parseMessageProtocolFacts } from "./message-protocol";

type SqlClient = typeof sql;
type CommentActorKind = "user" | "service_account" | "workflow";

export type MailCollaborator = {
  id: string;
  uid: string;
  displayName: string;
  avatarHash: string | null;
};

export type MailAssignableUser = MailCollaborator & {
  scope: "mailbox" | "assigned";
  permission: Exclude<PermissionLevel, "none">;
  description: string;
};

export type ConversationCollaboration = {
  conversationId: string;
  assignees: MailCollaborator[];
  workStatus: "needs_action" | "waiting" | "done";
  snoozedUntil: string | null;
  revision: number;
};

export type ConversationComment = {
  id: string;
  conversationId: string;
  body: string | null;
  author: {
    kind: CommentActorKind;
    id: string;
    displayName: string;
    avatarHash: string | null;
  };
  referencedMessageId: string | null;
  revision: number;
  canEdit: boolean;
  canDelete: boolean;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MailActivityEvent = {
  id: string;
  conversationId: string | null;
  actor: {
    kind: "user" | "service_account" | "workflow" | "system";
    id: string | null;
    displayName: string;
    avatarHash: string | null;
  };
  action: string;
  outcome: "requested" | "confirmed" | "failed" | "reconciled";
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type CollaborationRow = {
  id: string;
  assignees: MailCollaborator[];
  work_status: ConversationCollaboration["workStatus"];
  snoozed_until: Date | string | null;
  revision: string | number;
};

type WorkflowConversationCollaborationInput = Omit<UpdateConversationCollaboration, "completion"> & {
  workStatus?: ConversationCollaboration["workStatus"];
};

type AppliedConversationCollaborationInput = UpdateConversationCollaboration | WorkflowConversationCollaborationInput;

type CommentRow = {
  id: string;
  conversation_id: string;
  body_markdown: string;
  author_kind: CommentActorKind;
  author_id: string;
  author_display_name: string;
  author_avatar_hash: string | null;
  referenced_message_id: string | null;
  revision: string | number;
  edited_at: Date | string | null;
  deleted_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type ActivityRow = {
  id: string | number;
  conversation_id: string | null;
  actor_kind: MailActivityEvent["actor"]["kind"];
  actor_id: string | null;
  actor_display_name: string;
  actor_avatar_hash: string | null;
  action: string;
  outcome: MailActivityEvent["outcome"];
  target_type: string | null;
  target_id: string | null;
  conversation_reference_value: string | null;
  mailbox_short_id: string;
  metadata: Record<string, unknown> | string;
  created_at: Date | string;
};

type MutableCommentRow = {
  revision: string | number;
  body_markdown: string;
  author_kind: CommentActorKind;
  author_id: string;
  deleted_at: Date | string | null;
  created_at: Date | string;
};

export type CollaborationMutation<T> = {
  value: T;
  event: MailActivityChange | null;
};

type DateCursor = { version: 1; date: string; id: string };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const COMMENT_MUTATION_WINDOW_MS = 10 * 60 * 1000;

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const toNullableIso = (value: Date | string | null): string | null => (value ? toIso(value) : null);
const encodeDateCursor = (cursor: DateCursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");

const decodeDateCursor = (value: string | undefined): Result<DateCursor | null> => {
  if (!value) return ok(null);
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<DateCursor>;
    if (
      parsed.version !== 1 ||
      typeof parsed.date !== "string" ||
      !Number.isFinite(Date.parse(parsed.date)) ||
      typeof parsed.id !== "string" ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      return fail(err.badInput("Invalid pagination cursor"));
    }
    return ok(parsed as DateCursor);
  } catch {
    return fail(err.badInput("Invalid pagination cursor"));
  }
};

const encodeActivityCursor = (id: string): string => Buffer.from(JSON.stringify({ version: 1, id })).toString("base64url");

const decodeActivityCursor = (value: string | undefined): Result<string | null> => {
  if (!value) return ok(null);
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { version?: unknown; id?: unknown };
    if (
      parsed.version !== 1 ||
      typeof parsed.id !== "string" ||
      !/^[1-9]\d*$/.test(parsed.id) ||
      BigInt(parsed.id) > 9_223_372_036_854_775_807n
    ) {
      return fail(err.badInput("Invalid pagination cursor"));
    }
    return ok(parsed.id);
  } catch {
    return fail(err.badInput("Invalid pagination cursor"));
  }
};

const parseMetadata = (value: Record<string, unknown> | string): Record<string, unknown> =>
  typeof value === "string" ? (JSON.parse(value) as Record<string, unknown>) : value;

const actorIdentity = (context: MailRequestContext): { kind: CommentActorKind; id: string } => {
  const actor = actorRefFromRequest(context);
  if (actor.kind === "user") return { kind: "user", id: actor.userId };
  if (actor.kind === "service_account") return { kind: "service_account", id: actor.serviceAccountId };
  throw new Error("Request actor cannot author Mail collaboration changes");
};

const activityActorIdentity = (
  context: MailRequestContext | null,
  actorOverride?: ActorRef,
): { kind: ActorRef["kind"]; id: string | null } => {
  if (!actorOverride && !context) throw new Error("Mail activity requires an actor");
  const actor = actorOverride ?? actorRefFromRequest(context as MailRequestContext);
  if (actor.kind === "user") return { kind: actor.kind, id: actor.userId };
  if (actor.kind === "service_account") return { kind: actor.kind, id: actor.serviceAccountId };
  if (actor.kind === "workflow") return { kind: actor.kind, id: actor.workflowVersionId };
  return { kind: actor.kind, id: null };
};

const collaboratorFromAccessUser = (user: AccessUser): MailCollaborator => ({
  id: user.id,
  uid: user.uid,
  displayName: user.displayName,
  avatarHash: user.avatarHash,
});

const accessUserDescription = (user: AccessUser): string =>
  user.source.type === "direct" ? `${user.uid} · direct access` : `${user.uid} · via ${user.source.groupName}`;

export const listCurrentUsers = listCurrentMailboxUsers;
export { listEligibleAssignees };

export const requireMailboxCollaborationPermission = async (
  context: MailRequestContext,
  mailboxId: string,
  permission: "read" | "write",
  db: SqlClient = sql,
): Promise<Result<PermissionLevel>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, permission, db);
  if (!allowed.ok) return allowed;
  const execution = await resolveMailExecution({ mailboxId, operation: "actorRead", context, db });
  return execution.ok ? allowed : execution;
};

const validateAssignees = async (mailboxId: string, userIds: readonly string[], db: SqlClient): Promise<Result<void>> => {
  if (userIds.length > MAIL_CONVERSATION_ASSIGNEE_LIMIT)
    return fail(err.badInput(`A conversation can have at most ${MAIL_CONVERSATION_ASSIGNEE_LIMIT} assignees`));
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return ok();
  const users = await listEligibleAssignees({ mailboxId, userIds: ids, db, limit: ids.length });
  const found = new Set(users.map((user) => user.id));
  return ids.every((id) => found.has(id))
    ? ok()
    : fail(err.badInput("Assignees must be active users with mailbox write access or assigned access"));
};

export const listAssigneeCollaborators = async (userIds: readonly string[], db: SqlClient = sql): Promise<MailCollaborator[]> => {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return [];
  const users = await db<MailCollaborator[]>`
    SELECT id, uid, COALESCE(NULLIF(display_name, ''), uid) AS "displayName", avatar_hash AS "avatarHash"
    FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${ids}::jsonb))
  `;
  return ids.flatMap((id) => users.filter((user) => user.id === id));
};

export const loadConversationAssigneeIds = async (db: SqlClient, conversationId: string): Promise<string[]> => {
  const rows = await db<{ user_id: string }[]>`
    SELECT user_id FROM mail.conversation_assignees
    WHERE conversation_id = ${conversationId}::uuid ORDER BY assigned_at, user_id
  `;
  return rows.map((row) => row.user_id);
};

export const writeConversationAssignees = async (
  tx: SqlClient,
  params: {
    mailboxId: string;
    conversationId: string;
    userIds: readonly string[];
    assignedAt?: ReadonlyMap<string, string>;
  },
): Promise<void> => {
  const ids = [...new Set(params.userIds)];
  if (ids.length > MAIL_CONVERSATION_ASSIGNEE_LIMIT)
    throw new Error(`A conversation can have at most ${MAIL_CONVERSATION_ASSIGNEE_LIMIT} assignees`);
  const removed = await tx<{ user_id: string }[]>`
    DELETE FROM mail.conversation_assignees
    WHERE conversation_id = ${params.conversationId}::uuid
      AND user_id NOT IN (SELECT value::uuid FROM jsonb_array_elements_text(${ids}::jsonb))
    RETURNING user_id
  `;
  // Ordinality preserves request order even when several additions share one transaction timestamp.
  const additions = ids.map((userId, index) => ({ user_id: userId, assigned_at: params.assignedAt?.get(userId) ?? null, ordinal: index }));
  await tx`
    INSERT INTO mail.conversation_assignees (conversation_id, user_id, assigned_at)
    SELECT ${params.conversationId}::uuid, user_id, COALESCE(assigned_at, now() + ordinal * interval '1 microsecond')
    FROM jsonb_to_recordset(${additions}::jsonb) AS a(user_id uuid, assigned_at timestamptz, ordinal int)
    ORDER BY ordinal
    ON CONFLICT (conversation_id, user_id) DO UPDATE
      SET assigned_at = CASE WHEN ${params.assignedAt !== undefined}
        THEN LEAST(mail.conversation_assignees.assigned_at, EXCLUDED.assigned_at) ELSE mail.conversation_assignees.assigned_at END
  `;
  // Only this writer mirrors the earliest assignee for older Mail images; all reads use the join table.
  await tx`
    UPDATE mail.conversations SET assignee_user_id = (
      SELECT user_id FROM mail.conversation_assignees WHERE conversation_id = ${params.conversationId}::uuid
      ORDER BY assigned_at, user_id LIMIT 1
    ) WHERE id = ${params.conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
  `;
  if (removed.length > 0) {
    const [conversation] = await tx<
      { short_id: string }[]
    >`SELECT short_id FROM mail.conversations WHERE id = ${params.conversationId}::uuid`;
    if (!conversation) throw new Error("Conversation missing while publishing assignment removal");
    for (const user of removed)
      await mailLive.publish(tx, { key: `${params.mailboxId}:${user.user_id}`, data: { conversationId: conversation.short_id } });
  }
};

export const lockMailboxForCollaboration = async (
  context: MailRequestContext,
  mailboxId: string,
  permission: "read" | "write",
  db: SqlClient,
): Promise<Result<PermissionLevel>> => {
  const [mailbox] = await db<{ id: string }[]>`
    SELECT id FROM mail.mailboxes
    WHERE id = ${mailboxId}::uuid AND deleted_at IS NULL
    FOR SHARE
  `;
  if (!mailbox) return fail(err.notFound("Mailbox"));
  return requireMailboxCollaborationPermission(context, mailboxId, permission, db);
};

const loadCollaboration = async (
  mailboxId: string,
  conversationId: string,
  db: SqlClient = sql,
): Promise<ConversationCollaboration | null> => {
  const [row] = await db<CollaborationRow[]>`
    SELECT
      c.id,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', u.id, 'uid', u.uid, 'displayName', COALESCE(NULLIF(u.display_name, ''), u.uid), 'avatarHash', u.avatar_hash
      ) ORDER BY a.assigned_at, a.user_id)
      FROM mail.conversation_assignees a JOIN auth.users u ON u.id = a.user_id
      WHERE a.conversation_id = c.id), '[]'::jsonb) AS assignees,
      c.work_status,
      c.snoozed_until,
      c.revision
    FROM mail.conversations c
    WHERE c.id = ${conversationId}::uuid AND c.mailbox_id = ${mailboxId}::uuid
  `;
  if (!row) return null;
  return {
    conversationId: row.id,
    assignees: row.assignees,
    workStatus: row.work_status,
    snoozedUntil: toNullableIso(row.snoozed_until),
    revision: Number(row.revision),
  };
};

export const insertActivity = async (params: {
  db: SqlClient;
  mailboxId: string;
  conversationId: string;
  context: MailRequestContext | null;
  actorOverride?: ActorRef;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}): Promise<string> => {
  const actor = activityActorIdentity(params.context, params.actorOverride);
  const [event] = await params.db<{ id: string | number }[]>`
    INSERT INTO mail.activity_events (
      mailbox_id, conversation_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
    ) VALUES (
      ${params.mailboxId}::uuid,
      ${params.conversationId}::uuid,
      ${actor.kind},
      ${actor.id}::uuid,
      ${params.action},
      'confirmed',
      ${params.targetType},
      ${params.targetId}::uuid,
      ${params.metadata ?? {}}::jsonb
    )
    RETURNING id
  `;
  if (!event) throw new Error("Mail activity insert returned no row");
  return String(event.id);
};

const finishMutation = async <T>(result: Result<CollaborationMutation<T>>): Promise<Result<T>> => {
  if (!result.ok) return result;
  if (result.data.event) mailLive.wake();
  return ok(result.data.value);
};

export const listAssignableUsers = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  search?: string;
  limit?: number;
}): Promise<Result<MailAssignableUser[]>> => {
  const allowed = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const users = await listEligibleAssignees({
    mailboxId: params.mailboxId,
    search: params.search,
    limit: Math.min(Math.max(params.limit ?? 50, 1), 200),
  });
  return ok(
    users.map((user) => ({
      ...collaboratorFromAccessUser(user),
      scope: user.scope,
      permission: user.permission,
      description: accessUserDescription(user),
    })),
  );
};

export const getConversationCollaboration = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
}): Promise<Result<ConversationCollaboration>> => {
  const allowed = await requireMailboxAccess(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const visible = await requireVisibleConversation(allowed.data, params.conversationId);
  if (!visible.ok) return visible;
  const state = await loadCollaboration(params.mailboxId, params.conversationId);
  return state ? ok(state) : fail(err.notFound("Conversation"));
};

type ConversationCollaborationMutation = CollaborationMutation<ConversationCollaboration> & { addedUserIds: string[] };

const applyConversationCollaborationInTransaction = async (params: {
  context: MailRequestContext | null;
  mailboxId: string;
  conversationId: string;
  input: AppliedConversationCollaborationInput;
  db: SqlClient;
  actorOverride?: ActorRef;
  activityMetadata?: Record<string, unknown>;
  assigneesToValidate?: readonly string[];
}): Promise<Result<ConversationCollaborationMutation>> => {
  const [current] = await params.db<CollaborationRow[]>`
    SELECT
      c.id,
      '[]'::jsonb AS assignees,
      c.work_status,
      c.snoozed_until,
      c.revision
    FROM mail.conversations c
    WHERE c.id = ${params.conversationId}::uuid AND c.mailbox_id = ${params.mailboxId}::uuid
    FOR UPDATE
  `;
  if (!current) return fail(err.notFound("Conversation"));
  if (Number(current.revision) !== params.input.expectedRevision) {
    return fail(err.conflict("Conversation was changed by another collaborator"));
  }
  const currentAssigneeIds = await loadConversationAssigneeIds(params.db, params.conversationId);
  if (params.input.assigneeUserIds !== undefined) {
    const validAssignees = await validateAssignees(params.mailboxId, params.assigneesToValidate ?? params.input.assigneeUserIds, params.db);
    if (!validAssignees.ok) return validAssignees;
    if (params.input.assigneeUserIds.length > MAIL_CONVERSATION_ASSIGNEE_LIMIT)
      return fail(err.badInput(`A conversation can have at most ${MAIL_CONVERSATION_ASSIGNEE_LIMIT} assignees`));
  }

  let nextStatus = "workStatus" in params.input && params.input.workStatus ? params.input.workStatus : current.work_status;
  if ("completion" in params.input && params.input.completion === "done") nextStatus = "done";
  if ("completion" in params.input && params.input.completion === "open") {
    const [latest] = await params.db<
      {
        outbound: boolean;
        in_reply_to: string | null;
        reference_ids: string[];
        protocol_facts: Record<string, unknown> | string;
      }[]
    >`
      SELECT
        EXISTS (
          SELECT 1
          FROM mail.message_addresses sender
          JOIN mail.sender_identities identity
            ON identity.mailbox_id = conversation.mailbox_id
           AND lower(identity.from_address) = sender.normalized_email
          WHERE sender.message_id = message.id AND sender.role = 'from'
        ) AS outbound,
        message.in_reply_to,
        message.reference_ids,
        message.protocol_facts
      FROM mail.conversations conversation
      JOIN mail.conversation_messages link ON link.conversation_id = conversation.id
      JOIN mail.message_contents message ON message.id = link.message_id
      WHERE conversation.id = ${params.conversationId}::uuid
        AND message.hydration_status = 'complete'
        AND (
          NOT EXISTS (SELECT 1 FROM mail.outbox_submissions submission WHERE submission.message_id = message.id)
          OR EXISTS (
            SELECT 1
            FROM mail.outbox_submissions submission
            WHERE submission.message_id = message.id
              AND submission.state IN ('accepted', 'sent_sync_pending', 'sent', 'reconciled_accepted')
          )
        )
      ORDER BY message.internal_date DESC, message.id DESC
      LIMIT 1
    `;
    if (!latest) {
      nextStatus = "needs_action";
    } else {
      const facts = parseMessageProtocolFacts(
        typeof latest.protocol_facts === "string" ? JSON.parse(latest.protocol_facts) : latest.protocol_facts,
      );
      nextStatus = deriveReopenedConversationWorkStatus({
        direction: latest.outbound ? "outbound" : "inbound",
        intent: latest.outbound && (latest.in_reply_to || latest.reference_ids.length > 0) ? "observed_reply" : "observed_message",
        automatic: isAutomaticSubmission(facts.autoSubmitted),
      });
    }
  }
  const requestedSnooze =
    params.input.snoozedUntil === undefined
      ? undefined
      : params.input.snoozedUntil === null
        ? null
        : new Date(params.input.snoozedUntil).toISOString();
  if (requestedSnooze) {
    if (Date.parse(requestedSnooze) <= Date.now()) return fail(err.badInput("Snooze time must be in the future"));
    if (nextStatus === "done") return fail(err.badInput("A completed conversation cannot be snoozed"));
  }

  const nextAssigneeIds = params.input.assigneeUserIds === undefined ? currentAssigneeIds : [...new Set(params.input.assigneeUserIds)];
  const assigneesChanged =
    nextAssigneeIds.length !== currentAssigneeIds.length || nextAssigneeIds.some((id) => !currentAssigneeIds.includes(id));
  const completionChanged = "completion" in params.input && params.input.completion !== undefined;
  const nextSnoozedUntil =
    nextStatus === "done" || completionChanged
      ? null
      : requestedSnooze === undefined
        ? toNullableIso(current.snoozed_until)
        : requestedSnooze;
  const unchanged = !assigneesChanged && nextStatus === current.work_status && nextSnoozedUntil === toNullableIso(current.snoozed_until);
  if (unchanged) {
    const state = await loadCollaboration(params.mailboxId, params.conversationId, params.db);
    return state ? ok({ value: state, event: null, addedUserIds: [] }) : fail(err.notFound("Conversation"));
  }

  await params.db`
    UPDATE mail.conversations
    SET
      work_status = ${nextStatus},
      snoozed_until = ${nextSnoozedUntil}::timestamptz,
      revision = revision + 1
    WHERE id = ${params.conversationId}::uuid
  `;
  if (assigneesChanged)
    await writeConversationAssignees(params.db, {
      mailboxId: params.mailboxId,
      conversationId: params.conversationId,
      userIds: nextAssigneeIds,
    });
  const state = await loadCollaboration(params.mailboxId, params.conversationId, params.db);
  if (!state) return fail(err.internal("Updated conversation could not be loaded"));
  const activityId = await insertActivity({
    db: params.db,
    mailboxId: params.mailboxId,
    conversationId: params.conversationId,
    context: params.context,
    actorOverride: params.actorOverride,
    action: "conversation.collaboration_updated",
    targetType: "conversation",
    targetId: params.conversationId,
    metadata: {
      ...params.activityMetadata,
      before: {
        assigneeUserIds: currentAssigneeIds,
        workStatus: current.work_status,
        snoozedUntil: toNullableIso(current.snoozed_until),
        revision: Number(current.revision),
      },
      after: {
        assigneeUserIds: state.assignees.map((user) => user.id),
        workStatus: state.workStatus,
        snoozedUntil: state.snoozedUntil,
        revision: state.revision,
      },
    },
  });
  return ok({
    value: state,
    event: {
      mailboxId: params.mailboxId,
      conversationId: params.conversationId,
      reason: "collaboration",
      targetId: params.conversationId,
      activityId,
    },
    addedUserIds: nextAssigneeIds.filter((id) => !currentAssigneeIds.includes(id)),
  });
};

export const updateConversationCollaborationInTransaction = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  input: AppliedConversationCollaborationInput;
  db: SqlClient;
  actorOverride?: ActorRef;
  activityMetadata?: Record<string, unknown>;
}): Promise<Result<ConversationCollaborationMutation>> => {
  const allowed = await lockMailboxForCollaboration(params.context, params.mailboxId, "write", params.db);
  return allowed.ok ? applyConversationCollaborationInTransaction(params) : allowed;
};

export const updateWorkflowConversationCollaborationInTransaction = async (params: {
  mailboxId: string;
  workflowVersionId: string;
  conversationId: string;
  input: WorkflowConversationCollaborationInput;
  db: SqlClient;
  activityMetadata?: Record<string, unknown>;
}): Promise<Result<CollaborationMutation<ConversationCollaboration>>> => {
  const [mailbox] = await params.db<{ id: string }[]>`
    SELECT id FROM mail.mailboxes
    WHERE id = ${params.mailboxId}::uuid AND deleted_at IS NULL
    FOR SHARE
  `;
  if (!mailbox) return fail(err.notFound("Mailbox"));
  return applyConversationCollaborationInTransaction({
    ...params,
    context: null,
    actorOverride: { kind: "workflow", workflowVersionId: params.workflowVersionId },
  });
};

/**
 * Updates one conversation and reports an assignee change for the caller's
 * notification. Use `conversationAssignments.updateConversationCollaboration`,
 * which also notifies the new assignee.
 */
export const applyConversationCollaboration = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  input: UpdateConversationCollaboration;
}): Promise<Result<{ collaboration: ConversationCollaboration; assignment: ConversationAssignmentChange | null }>> => {
  let result: Result<{ mutation: ConversationCollaborationMutation; assignment: ConversationAssignmentChange | null }>;
  try {
    result = await sql.begin(async (tx) => {
      const applied = await updateConversationCollaborationInTransaction({ ...params, db: tx });
      if (!applied.ok) return applied;
      if (applied.data.addedUserIds.length === 0 || !applied.data.event) return ok({ mutation: applied.data, assignment: null });
      const [names] = await tx<{ mailbox_short_id: string; mailbox_name: string; conversation_short_id: string }[]>`
        SELECT m.short_id AS mailbox_short_id, m.name AS mailbox_name, c.short_id AS conversation_short_id
        FROM mail.conversations c
        JOIN mail.mailboxes m ON m.id = c.mailbox_id
        WHERE c.id = ${params.conversationId}::uuid
      `;
      if (!names) return fail(err.notFound("Conversation"));
      return ok({
        mutation: applied.data,
        assignment: {
          mailbox: { shortId: names.mailbox_short_id, name: names.mailbox_name },
          conversationIds: [names.conversation_short_id],
          activityIds: [applied.data.event.activityId],
          added: applied.data.addedUserIds.map((userId) => ({ userId, conversationIds: [names.conversation_short_id] })),
        },
      });
    });
  } catch {
    return fail(err.internal("Failed to update conversation collaboration"));
  }
  if (!result.ok) return result;
  const collaboration = await finishMutation(ok(result.data.mutation));
  return collaboration.ok ? ok({ collaboration: collaboration.data, assignment: result.data.assignment }) : collaboration;
};

export type ConversationAssignmentStatus = "ok" | "not_found";

export type ConversationAssignmentResult = {
  assignees: MailCollaborator[];
  /** One entry per requested conversation, in request order, keyed by its public id. */
  results: Array<{ conversationId: string; status: ConversationAssignmentStatus }>;
};

/** Committed assignment changes, grouped by newly added user for notifications. */
export type ConversationAssignmentChange = {
  mailbox: { shortId: string; name: string };
  /** Public ids of the conversations whose assignee set changed. */
  conversationIds: string[];
  activityIds: string[];
  added: Array<{ userId: string; conversationIds: string[] }>;
};

/**
 * Assigns or unassigns many conversations of one mailbox in one transaction.
 * Every conversation goes through the single-conversation collaboration path,
 * so permissions, assignee eligibility, and per-conversation activity stay
 * identical. Mail permissions are mailbox-wide: a caller without write access
 * fails the whole request, while ids that are not in this mailbox report
 * `not_found`. Use `conversationAssignments.assignConversations`, which also
 * notifies the assignee once.
 */
export const applyConversationAssignments = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationIds: readonly string[];
  assigneeUserIds: readonly string[];
  mode: "add" | "remove" | "replace";
}): Promise<
  Result<{
    result: ConversationAssignmentResult;
    change: ConversationAssignmentChange;
    collaborations: Map<string, ConversationCollaboration>;
  }>
> => {
  if (params.conversationIds.length === 0 || params.conversationIds.length > MAIL_CONVERSATION_BATCH_LIMIT)
    return fail(err.badInput(`Pass 1 to ${MAIL_CONVERSATION_BATCH_LIMIT} conversations`));
  if (params.assigneeUserIds.length > MAIL_CONVERSATION_ASSIGNEE_LIMIT)
    return fail(err.badInput(`A conversation can have at most ${MAIL_CONVERSATION_ASSIGNEE_LIMIT} assignees`));
  const userIds = [...new Set(params.assigneeUserIds)];
  if (params.mode !== "replace" && userIds.length === 0) return fail(err.badInput("Add and remove require at least one user"));
  const requestedIds = [...new Set(params.conversationIds)];
  type ChangeEvent = NonNullable<CollaborationMutation<ConversationCollaboration>["event"]>;
  type Committed = {
    assignees: MailCollaborator[];
    found: Set<string>;
    events: ChangeEvent[];
    changedIds: string[];
    added: Map<string, string[]>;
    collaborations: Map<string, ConversationCollaboration>;
    mailbox: { shortId: string; name: string };
  };
  let result: Result<Committed>;
  try {
    result = await sql.begin(async (tx): Promise<Result<Committed>> => {
      // Assignment always requires mailbox-wide write access, including removals.
      const allowed = await lockMailboxForCollaboration(params.context, params.mailboxId, "write", tx);
      if (!allowed.ok) return allowed;
      const [mailbox] = await tx<
        { short_id: string; name: string }[]
      >`SELECT short_id, name FROM mail.mailboxes WHERE id = ${params.mailboxId}::uuid`;
      if (!mailbox) return fail(err.notFound("Mailbox"));
      if (params.mode !== "remove") {
        const valid = await validateAssignees(params.mailboxId, userIds, tx);
        if (!valid.ok) return valid;
      }
      const users = await listAssigneeCollaborators(userIds, tx);
      // Stable lock order prevents concurrent bulk assignments from deadlocking.
      const rows = await tx<{ id: string; short_id: string; revision: string | number }[]>`
        SELECT id, short_id, revision FROM mail.conversations
        WHERE mailbox_id = ${params.mailboxId}::uuid AND short_id IN (SELECT value FROM jsonb_array_elements_text(${requestedIds}::jsonb))
        ORDER BY id FOR UPDATE
      `;
      const next = new Map<string, string[]>();
      for (const row of rows) {
        const current = await loadConversationAssigneeIds(tx, row.id);
        const ids =
          params.mode === "replace"
            ? userIds
            : params.mode === "add"
              ? [...new Set([...current, ...userIds])]
              : current.filter((id) => !userIds.includes(id));
        if (ids.length > MAIL_CONVERSATION_ASSIGNEE_LIMIT)
          return fail(err.badInput(`A conversation can have at most ${MAIL_CONVERSATION_ASSIGNEE_LIMIT} assignees`));
        next.set(row.id, ids);
      }
      const events: ChangeEvent[] = [];
      const changedIds: string[] = [];
      const added = new Map<string, string[]>();
      const collaborations = new Map<string, ConversationCollaboration>();
      for (const row of rows) {
        const applied = await applyConversationCollaborationInTransaction({
          context: params.context,
          mailboxId: params.mailboxId,
          conversationId: row.id,
          input: { expectedRevision: Number(row.revision), assigneeUserIds: next.get(row.id) },
          assigneesToValidate: [],
          db: tx,
        });
        if (!applied.ok) throw applied.error;
        collaborations.set(row.short_id, applied.data.value);
        if (applied.data.event) {
          events.push(applied.data.event);
          changedIds.push(row.short_id);
          for (const userId of applied.data.addedUserIds) added.set(userId, [...(added.get(userId) ?? []), row.short_id]);
        }
      }
      return ok({
        assignees: users,
        found: new Set(rows.map((row) => row.short_id)),
        events,
        changedIds,
        added,
        collaborations,
        mailbox: { shortId: mailbox.short_id, name: mailbox.name },
      });
    });
  } catch {
    return fail(err.internal("Failed to assign conversations"));
  }
  if (!result.ok) return result;
  const committed = result.data;
  if (committed.events.length > 0) mailLive.wake();
  return ok({
    collaborations: committed.collaborations,
    result: {
      assignees: committed.assignees,
      results: params.conversationIds.map((conversationId) => ({
        conversationId,
        status: committed.found.has(conversationId) ? "ok" : "not_found",
      })),
    },
    change: {
      mailbox: committed.mailbox,
      conversationIds: committed.changedIds,
      activityIds: committed.events.map((event) => event.activityId),
      added: [...committed.added].map(([userId, conversationIds]) => ({ userId, conversationIds })),
    },
  });
};

export const releaseDueSnoozes = async (batchSize = 500): Promise<number> => {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new TypeError("Snooze release batch size must be a positive safe integer");
  }
  let released = 0;
  for (;;) {
    const events = await sql.begin(
      async (tx) =>
        tx<{ mailbox_id: string; conversation_id: string; activity_id: string | number }[]>`
        WITH due AS (
          SELECT id, mailbox_id, snoozed_until
          FROM mail.conversations
          WHERE snoozed_until <= now()
          ORDER BY snoozed_until, id
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        ),
        updated AS (
          UPDATE mail.conversations conversation
          SET snoozed_until = NULL, revision = revision + 1, updated_at = now()
          FROM due
          WHERE conversation.id = due.id
          RETURNING conversation.id, conversation.mailbox_id, due.snoozed_until, conversation.revision
        )
        INSERT INTO mail.activity_events (
          mailbox_id, conversation_id, actor_kind, action, outcome, target_type, target_id, metadata
        )
        SELECT
          updated.mailbox_id,
          updated.id,
          'system',
          'conversation.snooze_expired',
          'confirmed',
          'conversation',
          updated.id,
          jsonb_build_object(
            'before', jsonb_build_object('snoozedUntil', updated.snoozed_until),
            'after', jsonb_build_object('snoozedUntil', NULL, 'revision', updated.revision)
          )
        FROM updated
        RETURNING mailbox_id, conversation_id, id AS activity_id
      `,
    );
    if (events.length > 0) mailLive.wake();
    released += events.length;
    if (events.length < batchSize) return released;
  }
};

const commentColumns = sql`
  comment.id,
  comment.conversation_id,
  comment.body_markdown,
  comment.author_kind,
  comment.author_id,
  COALESCE(
    NULLIF(author_user.display_name, ''),
    author_user.uid,
    author_service.name,
    CASE comment.author_kind
      WHEN 'user' THEN 'Former user'
      WHEN 'service_account' THEN 'Former service account'
      ELSE 'Workflow'
    END
  ) AS author_display_name,
  author_user.avatar_hash AS author_avatar_hash,
  comment.referenced_message_id,
  comment.revision,
  comment.edited_at,
  comment.deleted_at,
  comment.created_at,
  comment.updated_at
`;

const canMutateComment = (
  row: Pick<CommentRow, "author_kind" | "author_id" | "created_at" | "deleted_at">,
  actor?: { kind: CommentActorKind; id: string },
): boolean =>
  Boolean(
    actor &&
      !row.deleted_at &&
      row.author_kind === actor.kind &&
      row.author_id === actor.id &&
      Date.now() - new Date(row.created_at).getTime() <= COMMENT_MUTATION_WINDOW_MS,
  );

const mapComment = (row: CommentRow, actor?: { kind: CommentActorKind; id: string }): ConversationComment => {
  const canMutate = canMutateComment(row, actor);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    body: row.deleted_at ? null : row.body_markdown,
    author: {
      kind: row.author_kind,
      id: row.author_id,
      displayName: row.author_display_name,
      avatarHash: row.author_avatar_hash,
    },
    referencedMessageId: row.referenced_message_id,
    revision: Number(row.revision),
    canEdit: canMutate,
    canDelete: canMutate,
    editedAt: toNullableIso(row.edited_at),
    deletedAt: toNullableIso(row.deleted_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
};

const loadComment = async (params: {
  db: SqlClient;
  mailboxId: string;
  conversationId: string;
  commentId: string;
  actor?: { kind: CommentActorKind; id: string };
}): Promise<ConversationComment | null> => {
  const [row] = await params.db<CommentRow[]>`
    SELECT ${commentColumns}
    FROM mail.conversation_comments comment
    JOIN mail.conversations conversation ON conversation.id = comment.conversation_id
    LEFT JOIN auth.users author_user ON comment.author_kind = 'user' AND author_user.id = comment.author_id
    LEFT JOIN auth.service_accounts author_service
      ON comment.author_kind = 'service_account' AND author_service.id = comment.author_id
    WHERE comment.id = ${params.commentId}::uuid
      AND comment.conversation_id = ${params.conversationId}::uuid
      AND conversation.mailbox_id = ${params.mailboxId}::uuid
  `;
  return row ? mapComment(row, params.actor) : null;
};

export const getConversationComment = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  commentId: string;
}): Promise<Result<ConversationComment>> => {
  const allowed = await requireMailboxAccess(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const visible = await requireVisibleConversation(allowed.data, params.conversationId);
  if (!visible.ok) return visible;
  const comment = await loadComment({ db: sql, ...params, actor: actorIdentity(params.context) });
  return comment ? ok(comment) : fail(err.notFound("Comment"));
};

const validateCommentReferences = async (params: {
  db: SqlClient;
  conversationId: string;
  referencedMessageId?: string | null;
}): Promise<Result<void>> => {
  if (params.referencedMessageId) {
    const [message] = await params.db<{ message_id: string }[]>`
      SELECT message_id FROM mail.conversation_messages
      WHERE conversation_id = ${params.conversationId}::uuid
        AND message_id = ${params.referencedMessageId}::uuid
    `;
    if (!message) return fail(err.badInput("Referenced message must belong to this conversation"));
  }
  return ok();
};

const lockCommentForMutation = async (params: {
  db: SqlClient;
  mailboxId: string;
  conversationId: string;
  commentId: string;
  expectedRevision: number;
  actor: { kind: CommentActorKind; id: string };
  action: "edit" | "delete";
}): Promise<Result<MutableCommentRow>> => {
  const [comment] = await params.db<MutableCommentRow[]>`
    SELECT comment.revision, comment.body_markdown, comment.author_kind, comment.author_id, comment.deleted_at, comment.created_at
    FROM mail.conversation_comments comment
    JOIN mail.conversations conversation ON conversation.id = comment.conversation_id
    WHERE comment.id = ${params.commentId}::uuid
      AND comment.conversation_id = ${params.conversationId}::uuid
      AND conversation.mailbox_id = ${params.mailboxId}::uuid
    FOR UPDATE OF comment
  `;
  if (!comment) return fail(err.notFound("Comment"));
  if (comment.deleted_at)
    return fail(err.badInput(params.action === "edit" ? "Deleted comments cannot be edited" : "Comment is already deleted"));
  if (Number(comment.revision) !== params.expectedRevision) return fail(err.conflict("Comment was changed by another collaborator"));
  const owner = comment.author_kind === params.actor.kind && comment.author_id === params.actor.id;
  if (!owner) return fail(err.forbidden(`Only the comment author can ${params.action} this comment`));
  if (Date.now() - new Date(comment.created_at).getTime() > COMMENT_MUTATION_WINDOW_MS) {
    return fail(err.forbidden(`Comments can only be ${params.action === "edit" ? "edited" : "deleted"} within 10 minutes`));
  }
  return ok(comment);
};

export const listConversationComments = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  cursor?: string;
  limit?: number;
  order?: "oldest" | "newest";
}): Promise<Result<{ items: ConversationComment[]; nextCursor: string | null }>> => {
  const allowed = await requireMailboxAccess(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const visible = await requireVisibleConversation(allowed.data, params.conversationId);
  if (!visible.ok) return visible;
  const cursor = decodeDateCursor(params.cursor);
  if (!cursor.ok) return cursor;
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
  const newestFirst = params.order === "newest";
  const cursorPredicate = newestFirst
    ? sql`(comment.created_at, comment.id) < (${cursor.data?.date ?? null}::timestamptz, ${cursor.data?.id ?? null}::uuid)`
    : sql`(comment.created_at, comment.id) > (${cursor.data?.date ?? null}::timestamptz, ${cursor.data?.id ?? null}::uuid)`;
  const ordering = newestFirst ? sql`comment.created_at DESC, comment.id DESC` : sql`comment.created_at, comment.id`;
  const rows = await sql<(CommentRow & { cursor_at: string })[]>`
    SELECT ${commentColumns},
           to_char(comment.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
    FROM mail.conversation_comments comment
    JOIN mail.conversations conversation ON conversation.id = comment.conversation_id
    LEFT JOIN auth.users author_user ON comment.author_kind = 'user' AND author_user.id = comment.author_id
    LEFT JOIN auth.service_accounts author_service
      ON comment.author_kind = 'service_account' AND author_service.id = comment.author_id
    WHERE comment.conversation_id = ${params.conversationId}::uuid
      AND conversation.mailbox_id = ${params.mailboxId}::uuid
      AND (
        ${cursor.data?.id ?? null}::uuid IS NULL
        OR ${cursorPredicate}
      )
    ORDER BY ${ordering}
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const cursorRow = pageRows.at(-1);
  const actor = actorIdentity(params.context);
  const items = pageRows.map((row) => mapComment(row, actor));
  if (newestFirst) items.reverse();
  return ok({
    items,
    nextCursor: hasMore && cursorRow ? encodeDateCursor({ version: 1, date: cursorRow.cursor_at, id: cursorRow.id }) : null,
  });
};

export const createConversationComment = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  input: CreateConversationComment;
}): Promise<Result<ConversationComment>> => {
  try {
    const result = await sql.begin(async (tx): Promise<Result<CollaborationMutation<ConversationComment>>> => {
      const allowed = await lockMailboxForCollaboration(params.context, params.mailboxId, "read", tx);
      if (!allowed.ok) return allowed;
      const [conversation] = await tx<{ id: string }[]>`
        SELECT id FROM mail.conversations
        WHERE id = ${params.conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
        FOR UPDATE
      `;
      if (!conversation) return fail(err.notFound("Conversation"));
      const references = await validateCommentReferences({
        db: tx,
        conversationId: params.conversationId,
        referencedMessageId: params.input.referencedMessageId,
      });
      if (!references.ok) return references;
      const actor = actorIdentity(params.context);
      const commentRows = await withShortIdDb(
        tx,
        "comment",
        (db, shortId) => db<{ id: string }[]>`
        INSERT INTO mail.conversation_comments (
          short_id, conversation_id, author_kind, author_id, body_markdown, referenced_message_id
        ) VALUES (
          ${shortId},
          ${params.conversationId}::uuid,
          ${actor.kind},
          ${actor.id}::uuid,
          ${params.input.body},
          ${params.input.referencedMessageId ?? null}::uuid
        )
        RETURNING id
      `,
      );
      const [comment] = commentRows;
      if (!comment) return fail(err.internal("Comment insert returned no row"));
      await tx`
        INSERT INTO mail.conversation_comment_versions (
          comment_id, revision, body_markdown, editor_kind, editor_id, deleted
        ) VALUES (${comment.id}::uuid, 1, ${params.input.body}, ${actor.kind}, ${actor.id}::uuid, false)
      `;
      await tx`UPDATE mail.conversations SET updated_at = now() WHERE id = ${params.conversationId}::uuid`;
      const value = await loadComment({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: params.conversationId,
        commentId: comment.id,
        actor,
      });
      if (!value) return fail(err.internal("Created comment could not be loaded"));
      const activityId = await insertActivity({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: params.conversationId,
        context: params.context,
        action: "conversation.comment_created",
        targetType: "comment",
        targetId: comment.id,
        metadata: {
          revision: 1,
          referencedMessageId: value.referencedMessageId,
        },
      });
      return ok({
        value,
        event: {
          mailboxId: params.mailboxId,
          conversationId: params.conversationId,
          reason: "comment",
          targetId: comment.id,
          activityId,
        },
      });
    });
    return finishMutation(result);
  } catch {
    return fail(err.internal("Failed to create internal comment"));
  }
};

export const createWorkflowConversationCommentInTransaction = async (params: {
  db: SqlClient;
  mailboxId: string;
  conversationId: string;
  workflowVersionId: string;
  body: string;
}): Promise<Result<{ id: string; activityId: string }>> => {
  const parsed = createConversationCommentSchema.safeParse({ body: params.body });
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid internal comment"));
  const [conversation] = await params.db<{ id: string }[]>`
    SELECT id
    FROM mail.conversations
    WHERE id = ${params.conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
    FOR UPDATE
  `;
  if (!conversation) return fail(err.notFound("Conversation"));
  const commentRows = await withShortIdDb(
    params.db,
    "comment",
    (db, shortId) => db<{ id: string }[]>`
    INSERT INTO mail.conversation_comments (
      short_id, conversation_id, author_kind, author_id, body_markdown
    ) VALUES (
      ${shortId}, ${params.conversationId}::uuid, 'workflow', ${params.workflowVersionId}::uuid, ${parsed.data.body}
    )
    RETURNING id
  `,
  );
  const [comment] = commentRows;
  if (!comment) return fail(err.internal("Comment insert returned no row"));
  await params.db`
    INSERT INTO mail.conversation_comment_versions (
      comment_id, revision, body_markdown, editor_kind, editor_id, deleted
    ) VALUES (
      ${comment.id}::uuid, 1, ${parsed.data.body}, 'workflow', ${params.workflowVersionId}::uuid, false
    )
  `;
  await params.db`UPDATE mail.conversations SET updated_at = now() WHERE id = ${params.conversationId}::uuid`;
  const activityId = await insertActivity({
    db: params.db,
    mailboxId: params.mailboxId,
    conversationId: params.conversationId,
    context: null,
    actorOverride: { kind: "workflow", workflowVersionId: params.workflowVersionId },
    action: "conversation.comment_created",
    targetType: "comment",
    targetId: comment.id,
    metadata: { revision: 1, referencedMessageId: null },
  });
  return ok({ id: comment.id, activityId });
};

export const updateConversationComment = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  commentId: string;
  input: UpdateConversationComment;
}): Promise<Result<ConversationComment>> => {
  try {
    const result = await sql.begin(async (tx): Promise<Result<CollaborationMutation<ConversationComment>>> => {
      const allowed = await lockMailboxForCollaboration(params.context, params.mailboxId, "read", tx);
      if (!allowed.ok) return allowed;
      const actor = actorIdentity(params.context);
      const current = await lockCommentForMutation({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: params.conversationId,
        commentId: params.commentId,
        expectedRevision: params.input.expectedRevision,
        actor,
        action: "edit",
      });
      if (!current.ok) return current;
      if (current.data.body_markdown === params.input.body) {
        const value = await loadComment({
          db: tx,
          mailboxId: params.mailboxId,
          conversationId: params.conversationId,
          commentId: params.commentId,
          actor,
        });
        if (!value) return fail(err.notFound("Comment"));
        return ok({ value, event: null });
      }
      const revision = params.input.expectedRevision + 1;
      const [updated] = await tx<{ id: string }[]>`
        UPDATE mail.conversation_comments
        SET body_markdown = ${params.input.body}, revision = ${revision}, edited_at = now()
        WHERE id = ${params.commentId}::uuid
          AND author_kind = ${actor.kind}
          AND author_id = ${actor.id}::uuid
          AND created_at >= now() - interval '10 minutes'
        RETURNING id
      `;
      if (!updated) return fail(err.forbidden("Comments can only be edited within 10 minutes"));
      await tx`
        INSERT INTO mail.conversation_comment_versions (
          comment_id, revision, body_markdown, editor_kind, editor_id, deleted
        ) VALUES (${params.commentId}::uuid, ${revision}, ${params.input.body}, ${actor.kind}, ${actor.id}::uuid, false)
      `;
      await tx`UPDATE mail.conversations SET updated_at = now() WHERE id = ${params.conversationId}::uuid`;
      const value = await loadComment({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: params.conversationId,
        commentId: params.commentId,
        actor,
      });
      if (!value) return fail(err.internal("Updated comment could not be loaded"));
      const activityId = await insertActivity({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: params.conversationId,
        context: params.context,
        action: "conversation.comment_updated",
        targetType: "comment",
        targetId: params.commentId,
        metadata: { revision },
      });
      return ok({
        value,
        event: {
          mailboxId: params.mailboxId,
          conversationId: params.conversationId,
          reason: "comment",
          targetId: params.commentId,
          activityId,
        },
      });
    });
    return finishMutation(result);
  } catch {
    return fail(err.internal("Failed to update internal comment"));
  }
};

export const deleteConversationComment = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  commentId: string;
  input: DeleteConversationComment;
}): Promise<Result<ConversationComment>> => {
  try {
    const result = await sql.begin(async (tx): Promise<Result<CollaborationMutation<ConversationComment>>> => {
      const allowed = await lockMailboxForCollaboration(params.context, params.mailboxId, "read", tx);
      if (!allowed.ok) return allowed;
      const actor = actorIdentity(params.context);
      const current = await lockCommentForMutation({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: params.conversationId,
        commentId: params.commentId,
        expectedRevision: params.input.expectedRevision,
        actor,
        action: "delete",
      });
      if (!current.ok) return current;
      const revision = params.input.expectedRevision + 1;
      const [deleted] = await tx<{ id: string }[]>`
        UPDATE mail.conversation_comments
        SET revision = ${revision}, edited_at = now(), deleted_at = now()
        WHERE id = ${params.commentId}::uuid
          AND author_kind = ${actor.kind}
          AND author_id = ${actor.id}::uuid
          AND created_at >= now() - interval '10 minutes'
        RETURNING id
      `;
      if (!deleted) return fail(err.forbidden("Comments can only be deleted within 10 minutes"));
      await tx`
        INSERT INTO mail.conversation_comment_versions (
          comment_id, revision, body_markdown, editor_kind, editor_id, deleted
        ) VALUES (${params.commentId}::uuid, ${revision}, ${current.data.body_markdown}, ${actor.kind}, ${actor.id}::uuid, true)
      `;
      await tx`UPDATE mail.conversations SET updated_at = now() WHERE id = ${params.conversationId}::uuid`;
      const value = await loadComment({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: params.conversationId,
        commentId: params.commentId,
        actor,
      });
      if (!value) return fail(err.internal("Deleted comment could not be loaded"));
      const activityId = await insertActivity({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: params.conversationId,
        context: params.context,
        action: "conversation.comment_deleted",
        targetType: "comment",
        targetId: params.commentId,
        metadata: { revision },
      });
      return ok({
        value,
        event: {
          mailboxId: params.mailboxId,
          conversationId: params.conversationId,
          reason: "comment",
          targetId: params.commentId,
          activityId,
        },
      });
    });
    return finishMutation(result);
  } catch {
    return fail(err.internal("Failed to delete internal comment"));
  }
};

export const listActivity = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId?: string | null;
  cursor?: string;
  limit?: number;
}): Promise<Result<{ items: MailActivityEvent[]; nextCursor: string | null }>> => {
  const allowed = params.conversationId
    ? await requireMailboxAccess(params.context, params.mailboxId, "read")
    : await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  if (params.conversationId && typeof allowed.data === "object") {
    const visible = await requireVisibleConversation(allowed.data, params.conversationId);
    if (!visible.ok) return visible;
  }
  const cursor = decodeActivityCursor(params.cursor);
  if (!cursor.ok) return cursor;
  const visibility = typeof allowed.data === "object" ? allowed.data : ({ scope: "mailbox", permission: "read" } as const);
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
  const rows = await sql<ActivityRow[]>`
    SELECT
      activity.id,
      activity.conversation_id,
      activity.actor_kind,
      activity.actor_id,
      COALESCE(
        NULLIF(actor_user.display_name, ''),
        actor_user.uid,
        actor_service.name,
        actor_workflow.name,
        CASE activity.actor_kind
          WHEN 'workflow' THEN 'Workflow'
          WHEN 'system' THEN 'System'
          WHEN 'user' THEN 'Former user'
          ELSE 'Former service account'
        END
      ) AS actor_display_name,
      actor_user.avatar_hash AS actor_avatar_hash,
      activity.action,
      activity.outcome,
      activity.target_type,
      activity.target_id,
      activity_reference.value AS conversation_reference_value,
      activity_mailbox.short_id AS mailbox_short_id,
      activity.metadata,
      activity.created_at
    FROM mail.activity_events activity
    JOIN mail.mailboxes activity_mailbox ON activity_mailbox.id = activity.mailbox_id
    LEFT JOIN mail.conversation_references activity_reference
      ON activity.target_type = 'conversation_reference'
      AND activity_reference.id = activity.target_id
      AND activity_reference.mailbox_id = activity.mailbox_id
    LEFT JOIN auth.users actor_user ON activity.actor_kind = 'user' AND actor_user.id = activity.actor_id
    LEFT JOIN auth.service_accounts actor_service
      ON activity.actor_kind = 'service_account' AND actor_service.id = activity.actor_id
    LEFT JOIN workflows.version actor_workflow_version
      ON activity.actor_kind = 'workflow' AND actor_workflow_version.id = activity.actor_id
    LEFT JOIN workflows.workflow actor_workflow
      ON actor_workflow.id = actor_workflow_version.workflow_id
    WHERE activity.mailbox_id = ${params.mailboxId}::uuid
      AND (${params.conversationId ?? null}::uuid IS NULL OR activity.conversation_id = ${params.conversationId ?? null}::uuid)
      AND (${visibility.scope === "mailbox"} OR (
        activity.action NOT IN ('conversation.merged', 'conversation.message_reassigned', 'conversation.split', 'conversation.created_by_split')
        AND (activity.target_type IS DISTINCT FROM 'message' OR ${messageVisibleTo(visibility, sql`activity.target_id`)})
        AND (activity.target_type IS DISTINCT FROM 'comment' OR EXISTS (
          SELECT 1 FROM mail.conversation_comments comment
          WHERE comment.id = activity.target_id AND comment.conversation_id = activity.conversation_id
        ))
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_each_text(activity.metadata) metadata
          WHERE metadata.key IN ('messageId', 'sourceMessageId', 'derivedFromMessageId', 'referencedMessageId', 'outboundMessageId')
            AND metadata.value IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM mail.message_contents referenced_message
              WHERE referenced_message.id::text = metadata.value
                AND ${messageVisibleTo(visibility, sql`referenced_message.id`)}
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(CASE
            WHEN jsonb_typeof(activity.metadata -> 'messageIds') = 'array' THEN activity.metadata -> 'messageIds'
            ELSE '[]'::jsonb END) referenced_id(value)
          WHERE NOT EXISTS (
            SELECT 1 FROM mail.message_contents referenced_message
            WHERE referenced_message.id::text = referenced_id.value
              AND ${messageVisibleTo(visibility, sql`referenced_message.id`)}
          )
        )
      ))
      AND (${cursor.data ?? null}::bigint IS NULL OR activity.id < ${cursor.data ?? null}::bigint)
    ORDER BY activity.id DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = await projectActivityItems(
    pageRows.map((row) => ({
      id: String(row.id),
      conversationId: row.conversation_id,
      actor: {
        kind: row.actor_kind,
        id: row.actor_id,
        displayName: row.actor_display_name,
        avatarHash: row.actor_avatar_hash,
      },
      action: row.action,
      outcome: row.outcome,
      targetType: row.target_type,
      targetId:
        row.target_type === "conversation_reference"
          ? row.conversation_reference_value
          : row.target_type === "reference_configuration"
            ? row.mailbox_short_id
            : row.target_id,
      metadata: parseMetadata(row.metadata),
      createdAt: toIso(row.created_at),
    })),
  );
  const last = items.at(-1);
  return ok({
    items,
    nextCursor: hasMore && last ? encodeActivityCursor(last.id) : null,
  });
};
