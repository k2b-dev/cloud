import { err, fail, isServiceError, ok, type Result } from "@k2b/stdlib";
import { audit } from "@k2b/cloud/services";
import { sql } from "bun";
import type { AddConversationLocalTags, CreateLocalTag, DeleteLocalTag, SetConversationLocalTags, UpdateLocalTag } from "../contracts";
import { withShortIdDb } from "../lib/short-id";
import { requireMailboxPermission } from "./access";
import { actorRefFromRequest, auditActorFromRequest, type MailRequestContext } from "./auth";
import { insertActivity } from "./collaboration";
import { publishMailCollaborationEvent, publishMailMailboxEvent } from "./events";

type SqlClient = typeof sql;

type LocalTagRow = {
  id: string;
  short_id: string;
  mailbox_id: string;
  name: string;
  color: string;
  revision: string | number;
  created_at: Date | string;
  updated_at: Date | string;
};

export type LocalTag = {
  id: string;
  mailboxId: string;
  name: string;
  color: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type ConversationLocalTags = {
  conversationId: string;
  conversationRevision: number;
  tags: LocalTag[];
};

export type AddConversationLocalTagsResult = {
  updatedConversationIds: string[];
  unchangedConversationIds: string[];
};

export type WorkflowLocalTagMutation = {
  conversationRevision: number;
  applied: boolean;
  activityId: string | null;
};

type ActorIdentity = { kind: "user" | "service_account"; id: string };

const localTagColumns = sql`tag.id, tag.short_id, tag.mailbox_id, tag.name, tag.color, tag.revision, tag.created_at, tag.updated_at`;
const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const mapTag = (row: LocalTagRow): LocalTag => ({
  id: row.id,
  mailboxId: row.mailbox_id,
  name: row.name,
  color: row.color,
  revision: Number(row.revision),
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});
const normalizeName = (name: string): string => name.trim().replace(/\s+/gu, " ");

const mutationActor = (context: MailRequestContext): ActorIdentity => {
  const actor = actorRefFromRequest(context);
  if (actor.kind === "user") return { kind: "user", id: actor.userId };
  if (actor.kind === "service_account") return { kind: "service_account", id: actor.serviceAccountId };
  throw new Error("Request actor cannot mutate local tags");
};

const lockMailboxForWrite = async (context: MailRequestContext, mailboxId: string, db: SqlClient): Promise<Result<void>> => {
  const [mailbox] = await db<{ id: string }[]>`
    SELECT id FROM mail.mailboxes
    WHERE id = ${mailboxId}::uuid AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (!mailbox) return fail(err.notFound("Mailbox"));
  const allowed = await requireMailboxPermission(context, mailboxId, "write", db);
  return allowed.ok ? ok() : allowed;
};

const insertMailboxActivity = async (params: {
  db: SqlClient;
  context: MailRequestContext;
  mailboxId: string;
  action: string;
  targetId: string;
  metadata: Record<string, unknown>;
}): Promise<string> => {
  const actor = mutationActor(params.context);
  const [event] = await params.db<{ id: string | number }[]>`
    INSERT INTO mail.activity_events (
      mailbox_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
    ) VALUES (
      ${params.mailboxId}::uuid,
      ${actor.kind},
      ${actor.id}::uuid,
      ${params.action},
      'confirmed',
      'local_tag',
      ${params.targetId}::uuid,
      ${params.metadata}::jsonb
    )
    RETURNING id
  `;
  if (!event) throw new Error("Local tag activity insert returned no row");
  return String(event.id);
};

const databaseCode = (error: unknown): string | null => {
  const value = error as { code?: unknown; errno?: unknown } | null;
  return typeof value?.code === "string" ? value.code : typeof value?.errno === "string" ? value.errno : null;
};

const mutationFailure = (error: unknown, fallback: string): Result<never> => {
  if (isServiceError(error)) return fail(error);
  if (databaseCode(error) === "23505") return fail(err.conflict("Local tag name already exists"));
  return fail(err.internal(fallback));
};

export const listLocalTags = async (context: MailRequestContext, mailboxId: string): Promise<Result<LocalTag[]>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const rows = await sql<LocalTagRow[]>`
    SELECT ${localTagColumns}
    FROM mail.local_tags tag
    WHERE tag.mailbox_id = ${mailboxId}::uuid
    ORDER BY tag.normalized_name, tag.id
  `;
  return ok(rows.map(mapTag));
};

export const createLocalTag = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: CreateLocalTag;
}): Promise<Result<LocalTag>> => {
  const name = normalizeName(params.input.name);
  const actor = mutationActor(params.context);
  try {
    const result = await sql.begin(async (tx): Promise<Result<{ tag: LocalTag; activityId: string }>> => {
      const allowed = await lockMailboxForWrite(params.context, params.mailboxId, tx);
      if (!allowed.ok) return allowed;
      const rows = await withShortIdDb(
        tx,
        "tag",
        (db, shortId) => db<LocalTagRow[]>`
        INSERT INTO mail.local_tags (
          short_id, mailbox_id, name, normalized_name, color, created_by_actor_kind, created_by_actor_id
        ) VALUES (
          ${shortId},
          ${params.mailboxId}::uuid,
          ${name},
          lower(regexp_replace(${name}, '\\s+', ' ', 'g')),
          ${params.input.color},
          ${actor.kind},
          ${actor.id}::uuid
        )
        RETURNING id, short_id, mailbox_id, name, color, revision, created_at, updated_at
      `,
      );
      const [row] = rows;
      if (!row) throw new Error("Local tag insert returned no row");
      const tag = mapTag(row);
      const activityId = await insertMailboxActivity({
        db: tx,
        context: params.context,
        mailboxId: params.mailboxId,
        action: "local_tag.created",
        targetId: row.id,
        metadata: { name: tag.name, color: tag.color, revision: tag.revision },
      });
      await audit.record(
        {
          action: "mail.local_tag.create",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "local_tag", id: tag.id, label: tag.name },
          requestId: params.context.requestId,
          metadata: { mailboxId: params.mailboxId, revision: tag.revision },
        },
        tx,
      );
      return ok({ tag, activityId });
    });
    if (!result.ok) return result;
    await publishMailMailboxEvent({
      mailboxId: params.mailboxId,
      conversationId: null,
      reason: "local_tag",
      targetId: result.data.tag.id,
      activityId: result.data.activityId,
    });
    return ok(result.data.tag);
  } catch (error) {
    return mutationFailure(error, "Failed to create local tag");
  }
};

export const updateLocalTag = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  tagId: string;
  input: UpdateLocalTag;
}): Promise<Result<LocalTag>> => {
  try {
    const result = await sql.begin(async (tx): Promise<Result<{ tag: LocalTag; activityId: string | null }>> => {
      const allowed = await lockMailboxForWrite(params.context, params.mailboxId, tx);
      if (!allowed.ok) return allowed;
      const [current] = await tx<LocalTagRow[]>`
        SELECT ${localTagColumns}
        FROM mail.local_tags tag
        WHERE tag.id = ${params.tagId}::uuid AND tag.mailbox_id = ${params.mailboxId}::uuid
        FOR UPDATE
      `;
      if (!current) return fail(err.notFound("Local tag"));
      if (Number(current.revision) !== params.input.expectedRevision) return fail(err.conflict("Local tag was changed"));
      const name = params.input.name === undefined ? current.name : normalizeName(params.input.name);
      const color = params.input.color ?? current.color;
      if (current.name === name && current.color === color) return ok({ tag: mapTag(current), activityId: null });
      const [updated] = await tx<LocalTagRow[]>`
        UPDATE mail.local_tags tag
        SET
          name = ${name},
          normalized_name = lower(regexp_replace(${name}, '\\s+', ' ', 'g')),
          color = ${color},
          revision = revision + 1
        WHERE tag.id = ${params.tagId}::uuid
        RETURNING tag.id, tag.short_id, tag.mailbox_id, tag.name, tag.color, tag.revision, tag.created_at, tag.updated_at
      `;
      if (!updated) throw new Error("Local tag update returned no row");
      const tag = mapTag(updated);
      const activityId = await insertMailboxActivity({
        db: tx,
        context: params.context,
        mailboxId: params.mailboxId,
        action: "local_tag.updated",
        targetId: updated.id,
        metadata: {
          before: { name: current.name, color: current.color, revision: Number(current.revision) },
          after: { name: tag.name, color: tag.color, revision: tag.revision },
        },
      });
      await audit.record(
        {
          action: "mail.local_tag.update",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "local_tag", id: tag.id, label: tag.name },
          requestId: params.context.requestId,
          metadata: {
            mailboxId: params.mailboxId,
            beforeName: current.name,
            beforeColor: current.color,
            revision: tag.revision,
          },
        },
        tx,
      );
      return ok({ tag, activityId });
    });
    if (!result.ok) return result;
    if (result.data.activityId) {
      await publishMailMailboxEvent({
        mailboxId: params.mailboxId,
        conversationId: null,
        reason: "local_tag",
        targetId: result.data.tag.id,
        activityId: result.data.activityId,
      });
    }
    return ok(result.data.tag);
  } catch (error) {
    return mutationFailure(error, "Failed to update local tag");
  }
};

export const deleteLocalTag = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  tagId: string;
  input: DeleteLocalTag;
}): Promise<Result<void>> => {
  try {
    const result = await sql.begin(async (tx): Promise<Result<{ activityId: string }>> => {
      const allowed = await lockMailboxForWrite(params.context, params.mailboxId, tx);
      if (!allowed.ok) return allowed;
      const [current] = await tx<LocalTagRow[]>`
        SELECT ${localTagColumns}
        FROM mail.local_tags tag
        WHERE tag.id = ${params.tagId}::uuid AND tag.mailbox_id = ${params.mailboxId}::uuid
        FOR UPDATE
      `;
      if (!current) return fail(err.notFound("Local tag"));
      if (Number(current.revision) !== params.input.expectedRevision) return fail(err.conflict("Local tag was changed"));
      const affectedConversations = await tx<{ conversation_id: string }[]>`
        SELECT conversation_id
        FROM mail.conversation_local_tags
        WHERE mailbox_id = ${params.mailboxId}::uuid AND tag_id = ${params.tagId}::uuid
        ORDER BY conversation_id
        FOR UPDATE
      `;
      await tx`DELETE FROM mail.local_tags WHERE id = ${params.tagId}::uuid`;
      if (affectedConversations.length > 0) {
        await tx`
          UPDATE mail.conversations
          SET revision = revision + 1, updated_at = now()
          WHERE mailbox_id = ${params.mailboxId}::uuid
            AND id IN (
              SELECT value::uuid
              FROM jsonb_array_elements_text(${affectedConversations.map((row) => row.conversation_id)}::jsonb)
            )
        `;
      }
      const activityId = await insertMailboxActivity({
        db: tx,
        context: params.context,
        mailboxId: params.mailboxId,
        action: "local_tag.deleted",
        targetId: params.tagId,
        metadata: { name: current.name, revision: Number(current.revision), affectedConversations: affectedConversations.length },
      });
      await audit.record(
        {
          action: "mail.local_tag.delete",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "local_tag", id: params.tagId, label: current.name },
          requestId: params.context.requestId,
          metadata: {
            mailboxId: params.mailboxId,
            revision: Number(current.revision),
            affectedConversations: affectedConversations.length,
          },
        },
        tx,
      );
      return ok({ activityId });
    });
    if (!result.ok) return result;
    await publishMailMailboxEvent({
      mailboxId: params.mailboxId,
      conversationId: null,
      reason: "local_tag",
      targetId: params.tagId,
      activityId: result.data.activityId,
    });
    return ok();
  } catch (error) {
    return mutationFailure(error, "Failed to delete local tag");
  }
};

const loadConversationLocalTags = async (
  mailboxId: string,
  conversationId: string,
  db: SqlClient = sql,
): Promise<ConversationLocalTags | null> => {
  const [conversation] = await db<{ revision: string | number }[]>`
    SELECT revision
    FROM mail.conversations
    WHERE id = ${conversationId}::uuid AND mailbox_id = ${mailboxId}::uuid
  `;
  if (!conversation) return null;
  const rows = await db<LocalTagRow[]>`
    SELECT ${localTagColumns}
    FROM mail.conversation_local_tags assignment
    JOIN mail.local_tags tag ON tag.id = assignment.tag_id AND tag.mailbox_id = assignment.mailbox_id
    WHERE assignment.mailbox_id = ${mailboxId}::uuid AND assignment.conversation_id = ${conversationId}::uuid
    ORDER BY tag.normalized_name, tag.id
  `;
  return { conversationId, conversationRevision: Number(conversation.revision), tags: rows.map(mapTag) };
};

export const getConversationLocalTags = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
}): Promise<Result<ConversationLocalTags>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const state = await loadConversationLocalTags(params.mailboxId, params.conversationId);
  return state ? ok(state) : fail(err.notFound("Conversation"));
};

export const listConversationLocalTags = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationIds: string[];
}): Promise<Result<Map<string, LocalTag[]>>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const conversationIds = [...new Set(params.conversationIds)].sort();
  if (conversationIds.length === 0) return ok(new Map());
  if (conversationIds.length > 100) return fail(err.badInput("At most 100 conversations can be loaded at once"));
  const rows = await sql<(LocalTagRow & { conversation_id: string })[]>`
    SELECT assignment.conversation_id, ${localTagColumns}
    FROM mail.conversation_local_tags assignment
    JOIN mail.local_tags tag ON tag.id = assignment.tag_id AND tag.mailbox_id = assignment.mailbox_id
    WHERE assignment.mailbox_id = ${params.mailboxId}::uuid
      AND assignment.conversation_id IN (
        SELECT value::uuid FROM jsonb_array_elements_text(${conversationIds}::jsonb)
      )
    ORDER BY assignment.conversation_id, tag.normalized_name, tag.id
  `;
  const tagsByConversation = new Map<string, LocalTag[]>();
  for (const row of rows) {
    const current = tagsByConversation.get(row.conversation_id) ?? [];
    current.push(mapTag(row));
    tagsByConversation.set(row.conversation_id, current);
  }
  return ok(tagsByConversation);
};

export const addConversationLocalTags = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: AddConversationLocalTags;
}): Promise<Result<AddConversationLocalTagsResult>> => {
  const actor = mutationActor(params.context);
  // Stable lock order prevents concurrent bulk assignments from deadlocking.
  const conversationIds = [...params.input.conversationIds].sort();
  const tagIds = [...params.input.tagIds].sort();
  try {
    const result = await sql.begin(
      async (
        tx,
      ): Promise<Result<{ response: AddConversationLocalTagsResult; events: Array<{ conversationId: string; activityId: string }> }>> => {
        const allowed = await lockMailboxForWrite(params.context, params.mailboxId, tx);
        if (!allowed.ok) return allowed;

        const conversations = await tx<{ id: string }[]>`
          SELECT id
          FROM mail.conversations
          WHERE mailbox_id = ${params.mailboxId}::uuid
            AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(${conversationIds}::jsonb))
          ORDER BY id
          FOR UPDATE
        `;
        if (conversations.length !== conversationIds.length) {
          return fail(err.badInput("Every conversation must belong to this mailbox"));
        }

        const tags = await tx<{ id: string }[]>`
          SELECT id
          FROM mail.local_tags
          WHERE mailbox_id = ${params.mailboxId}::uuid
            AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(${tagIds}::jsonb))
          ORDER BY id
          FOR SHARE
        `;
        if (tags.length !== tagIds.length) return fail(err.badInput("Every tag must belong to this mailbox"));

        const inserted = await tx<{ conversation_id: string; tag_id: string }[]>`
          INSERT INTO mail.conversation_local_tags (
            mailbox_id, conversation_id, tag_id, assigned_by_actor_kind, assigned_by_actor_id
          )
          SELECT
            ${params.mailboxId}::uuid,
            conversation.value::uuid,
            tag.value::uuid,
            ${actor.kind},
            ${actor.id}::uuid
          FROM jsonb_array_elements_text(${conversationIds}::jsonb) conversation
          CROSS JOIN jsonb_array_elements_text(${tagIds}::jsonb) tag
          ON CONFLICT (conversation_id, tag_id) DO NOTHING
          RETURNING conversation_id, tag_id
        `;

        const insertedByConversation = new Map<string, string[]>();
        for (const row of inserted) {
          const current = insertedByConversation.get(row.conversation_id) ?? [];
          current.push(row.tag_id);
          insertedByConversation.set(row.conversation_id, current);
        }
        const updatedConversationIds = [...insertedByConversation.keys()].sort();
        const unchangedConversationIds = conversationIds.filter((conversationId) => !insertedByConversation.has(conversationId));
        if (updatedConversationIds.length === 0) {
          return ok({ response: { updatedConversationIds, unchangedConversationIds }, events: [] });
        }

        const updated = await tx<{ id: string; revision: string | number }[]>`
          UPDATE mail.conversations
          SET revision = revision + 1, updated_at = now()
          WHERE mailbox_id = ${params.mailboxId}::uuid
            AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(${updatedConversationIds}::jsonb))
          RETURNING id, revision
        `;
        if (updated.length !== updatedConversationIds.length) throw new Error("Tagged conversations could not be updated");
        const revisions = new Map(updated.map((row) => [row.id, Number(row.revision)]));
        const events: Array<{ conversationId: string; activityId: string }> = [];
        for (const conversationId of updatedConversationIds) {
          const addedTagIds = insertedByConversation.get(conversationId)!.sort();
          const activityId = await insertActivity({
            db: tx,
            mailboxId: params.mailboxId,
            conversationId,
            context: params.context,
            action: "conversation.local_tags_added",
            targetType: "conversation",
            targetId: conversationId,
            metadata: { addedTagIds, revision: revisions.get(conversationId) },
          });
          await audit.record(
            {
              action: "mail.conversation.tags.add",
              outcome: "allowed",
              actor: auditActorFromRequest(params.context),
              target: { type: "conversation", id: conversationId },
              requestId: params.context.requestId,
              metadata: { mailboxId: params.mailboxId, addedTagIds, revision: revisions.get(conversationId) },
            },
            tx,
          );
          events.push({ conversationId, activityId });
        }
        return ok({ response: { updatedConversationIds, unchangedConversationIds }, events });
      },
    );
    if (!result.ok) return result;
    await Promise.all(
      result.data.events.map((event) =>
        publishMailCollaborationEvent({
          mailboxId: params.mailboxId,
          conversationId: event.conversationId,
          reason: "local_tag",
          targetId: event.conversationId,
          activityId: event.activityId,
        }),
      ),
    );
    return ok(result.data.response);
  } catch (error) {
    return mutationFailure(error, "Failed to add conversation tags");
  }
};

export const updateWorkflowConversationLocalTagInTransaction = async (params: {
  db: SqlClient;
  mailboxId: string;
  conversationId: string;
  workflowVersionId: string;
  expectedRevision: number;
  tagId: string;
  operation: "add" | "remove";
}): Promise<Result<WorkflowLocalTagMutation>> => {
  const [conversation] = await params.db<{ revision: string | number }[]>`
    SELECT revision
    FROM mail.conversations
    WHERE id = ${params.conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
    FOR UPDATE
  `;
  if (!conversation) return fail(err.notFound("Conversation"));
  if (Number(conversation.revision) !== params.expectedRevision) {
    return fail(err.conflict("Conversation was changed by another collaborator"));
  }
  const [tag] = await params.db<{ id: string }[]>`
    SELECT id
    FROM mail.local_tags
    WHERE id = ${params.tagId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
    FOR SHARE
  `;
  if (!tag) return fail(err.badInput("Local tag no longer belongs to this mailbox"));
  const changed =
    params.operation === "add"
      ? await params.db<{ tag_id: string }[]>`
          INSERT INTO mail.conversation_local_tags (
            mailbox_id, conversation_id, tag_id, assigned_by_actor_kind, assigned_by_actor_id
          ) VALUES (
            ${params.mailboxId}::uuid, ${params.conversationId}::uuid, ${params.tagId}::uuid,
            'workflow', ${params.workflowVersionId}::uuid
          )
          ON CONFLICT (conversation_id, tag_id) DO NOTHING
          RETURNING tag_id
        `
      : await params.db<{ tag_id: string }[]>`
          DELETE FROM mail.conversation_local_tags
          WHERE mailbox_id = ${params.mailboxId}::uuid
            AND conversation_id = ${params.conversationId}::uuid
            AND tag_id = ${params.tagId}::uuid
          RETURNING tag_id
        `;
  if (changed.length === 0) {
    return ok({ conversationRevision: Number(conversation.revision), applied: false, activityId: null });
  }
  const [updated] = await params.db<{ revision: string | number }[]>`
    UPDATE mail.conversations
    SET revision = revision + 1, updated_at = now()
    WHERE id = ${params.conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
    RETURNING revision
  `;
  if (!updated) return fail(err.internal("Tagged conversation could not be updated"));
  const activityId = await insertActivity({
    db: params.db,
    mailboxId: params.mailboxId,
    conversationId: params.conversationId,
    context: null,
    actorOverride: { kind: "workflow", workflowVersionId: params.workflowVersionId },
    action: params.operation === "add" ? "conversation.local_tag_added" : "conversation.local_tag_removed",
    targetType: "local_tag",
    targetId: params.tagId,
    metadata: { beforeRevision: Number(conversation.revision), afterRevision: Number(updated.revision) },
  });
  return ok({ conversationRevision: Number(updated.revision), applied: true, activityId });
};

export const setConversationLocalTags = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  input: SetConversationLocalTags;
}): Promise<Result<ConversationLocalTags>> => {
  const actor = mutationActor(params.context);
  const requestedTagIds = [...params.input.tagIds].sort();
  try {
    const result = await sql.begin(
      async (tx): Promise<Result<{ state: ConversationLocalTags; activityId: string | null; conversationId: string }>> => {
        const allowed = await lockMailboxForWrite(params.context, params.mailboxId, tx);
        if (!allowed.ok) return allowed;
        const conversationId = params.conversationId;
        const tagIds = requestedTagIds;
        const [conversation] = await tx<{ revision: string | number }[]>`
        SELECT revision
        FROM mail.conversations
        WHERE id = ${conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
        FOR UPDATE
      `;
        if (!conversation) return fail(err.notFound("Conversation"));
        if (Number(conversation.revision) !== params.input.expectedRevision) {
          return fail(err.conflict("Conversation was changed by another collaborator"));
        }
        const validTags = await tx<{ id: string }[]>`
        SELECT id
        FROM mail.local_tags
        WHERE mailbox_id = ${params.mailboxId}::uuid
          AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(${tagIds}::jsonb))
        ORDER BY id
        FOR SHARE
      `;
        if (validTags.length !== tagIds.length) return fail(err.badInput("Every local tag must belong to this mailbox"));
        const existingRows = await tx<{ tag_id: string }[]>`
        SELECT tag_id
        FROM mail.conversation_local_tags
        WHERE mailbox_id = ${params.mailboxId}::uuid AND conversation_id = ${conversationId}::uuid
        ORDER BY tag_id
        FOR UPDATE
      `;
        const existingTagIds = existingRows.map((row) => row.tag_id);
        if (existingTagIds.length === tagIds.length && existingTagIds.every((id, index) => id === tagIds[index])) {
          const state = await loadConversationLocalTags(params.mailboxId, conversationId, tx);
          if (!state) return fail(err.notFound("Conversation"));
          return ok({ state, activityId: null, conversationId });
        }
        await tx`
        DELETE FROM mail.conversation_local_tags
        WHERE mailbox_id = ${params.mailboxId}::uuid AND conversation_id = ${conversationId}::uuid
      `;
        if (requestedTagIds.length > 0) {
          await tx`
          INSERT INTO mail.conversation_local_tags (
            mailbox_id, conversation_id, tag_id, assigned_by_actor_kind, assigned_by_actor_id
          )
          SELECT
            ${params.mailboxId}::uuid,
            ${conversationId}::uuid,
            value::uuid,
            ${actor.kind},
            ${actor.id}::uuid
          FROM jsonb_array_elements_text(${tagIds}::jsonb)
        `;
        }
        await tx`
        UPDATE mail.conversations
        SET revision = revision + 1, updated_at = now()
        WHERE id = ${conversationId}::uuid
      `;
        const state = await loadConversationLocalTags(params.mailboxId, conversationId, tx);
        if (!state) return fail(err.internal("Updated conversation tags could not be loaded"));
        const activityId = await insertActivity({
          db: tx,
          mailboxId: params.mailboxId,
          conversationId,
          context: params.context,
          action: "conversation.local_tags_updated",
          targetType: "conversation",
          targetId: conversationId,
          metadata: {
            before: { tagIds: existingTagIds, revision: Number(conversation.revision) },
            after: { tagIds: requestedTagIds, revision: state.conversationRevision },
          },
        });
        await audit.record(
          {
            action: "mail.conversation.local_tags.update",
            outcome: "allowed",
            actor: auditActorFromRequest(params.context),
            target: { type: "conversation", id: params.conversationId },
            requestId: params.context.requestId,
            metadata: { mailboxId: params.mailboxId, beforeTagIds: existingTagIds, afterTagIds: requestedTagIds },
          },
          tx,
        );
        return ok({ state, activityId, conversationId });
      },
    );
    if (!result.ok) return result;
    if (result.data.activityId) {
      await publishMailCollaborationEvent({
        mailboxId: params.mailboxId,
        conversationId: result.data.conversationId,
        reason: "local_tag",
        targetId: params.conversationId,
        activityId: result.data.activityId,
      });
    }
    return ok(result.data.state);
  } catch (error) {
    return mutationFailure(error, "Failed to update conversation local tags");
  }
};
