import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type {
  CreateSavedConversationView,
  MailSearchExpression,
  SavedConversationViewFilter,
  SavedConversationViewScope,
  UpdateSavedConversationView,
} from "../contracts";
import { internalMailSearchStateSchema } from "../contracts";
import { withShortIdDb } from "../lib/short-id";
import { MAIL_SEARCH_MATCHES_NOTHING, mailSearchReferences, replaceMailSearchReferences } from "../search-state";
import { type MailRequestContext, userBackedActor } from "./auth";
import { lockMailboxForCollaboration } from "./collaboration";
import { hasCurrentMailboxUserPermission } from "./collaborators";
import * as publicResources from "./public-resources";
import * as search from "./search";

type SqlClient = typeof sql;

type SavedViewRow = {
  id: string;
  mailbox_id: string;
  scope: SavedConversationViewScope;
  owner_user_id: string | null;
  name: string;
  filter: SavedConversationViewFilter | string;
  revision: string | number;
  created_at: Date | string;
  updated_at: Date | string;
};

export type SavedConversationView = {
  id: string;
  mailboxId: string;
  scope: SavedConversationViewScope;
  ownerUserId: string | null;
  name: string;
  filter: SavedConversationViewFilter;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
// Stored filters carry internal folder and tag IDs; the API resolves public IDs before a view is written.
const parseFilter = (value: SavedConversationViewFilter | string): Result<SavedConversationViewFilter> => {
  try {
    const parsed = internalMailSearchStateSchema.safeParse(typeof value === "string" ? JSON.parse(value) : value);
    return parsed.success ? ok(parsed.data) : fail(err.internal("Saved conversation view contains invalid search state"));
  } catch {
    return fail(err.internal("Saved conversation view contains malformed search state"));
  }
};

/**
 * A folder or tag deleted after a view was saved can no longer match. Its condition is returned as a
 * match-nothing term, so the view still loads and never carries an ID without a public counterpart.
 */
const withCurrentReferences = async (views: SavedConversationView[], db: SqlClient): Promise<SavedConversationView[]> => {
  const references = views.flatMap((view) => mailSearchReferences(view.filter.expression));
  if (references.length === 0) return views;
  const [folders, tags] = await Promise.all([
    publicResources.publicIds(
      "folders",
      references.map((reference) => (reference.type === "folder_id" ? reference.folderId : null)),
      db,
    ),
    publicResources.publicIds(
      "tags",
      references.map((reference) => (reference.type === "local_tag_id" ? reference.tagId : null)),
      db,
    ),
  ]);
  return views.map((view) => ({
    ...view,
    filter: {
      ...view.filter,
      expression: replaceMailSearchReferences(view.filter.expression, (reference) =>
        (reference.type === "folder_id" ? folders.has(reference.folderId) : tags.has(reference.tagId))
          ? reference
          : MAIL_SEARCH_MATCHES_NOTHING,
      ),
    },
  }));
};

const mapCurrentView = async (row: SavedViewRow, db: SqlClient): Promise<Result<SavedConversationView>> => {
  const view = mapView(row);
  if (!view.ok) return view;
  const [current] = await withCurrentReferences([view.data], db);
  return ok(current!);
};

const mapView = (row: SavedViewRow): Result<SavedConversationView> => {
  const filter = parseFilter(row.filter);
  if (!filter.ok) return filter;
  return ok({
    id: row.id,
    mailboxId: row.mailbox_id,
    scope: row.scope,
    ownerUserId: row.owner_user_id,
    name: row.name,
    filter: filter.data,
    revision: Number(row.revision),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
};

const viewColumns = sql`
  id,
  mailbox_id,
  scope,
  owner_user_id,
  name,
  filter,
  revision,
  created_at,
  updated_at
`;

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";

const actorIdentity = (context: MailRequestContext): { kind: "user" | "service_account"; id: string } => {
  return context.actor.kind === "user"
    ? { kind: "user", id: context.actor.user.id }
    : { kind: "service_account", id: context.actor.serviceAccount.id };
};

const insertViewActivity = async (params: {
  db: SqlClient;
  context: MailRequestContext;
  mailboxId: string;
  viewId: string;
  action: string;
  metadata: Record<string, unknown>;
}): Promise<void> => {
  const actor = actorIdentity(params.context);
  await params.db`
    INSERT INTO mail.activity_events (
      mailbox_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
    ) VALUES (
      ${params.mailboxId}::uuid,
      ${actor.kind},
      ${actor.id}::uuid,
      ${params.action},
      'confirmed',
      'saved_conversation_view',
      ${params.viewId}::uuid,
      ${params.metadata}::jsonb
    )
  `;
};

const validateFilterReferences = async (params: {
  db: SqlClient;
  mailboxId: string;
  filter: SavedConversationViewFilter;
}): Promise<Result<void>> => {
  const nodes: MailSearchExpression[] = [params.filter.expression];
  const folderIds = new Set<string>();
  const userIds = new Set<string>();
  while (nodes.length > 0) {
    const node = nodes.pop()!;
    if (node.type === "and" || node.type === "or") nodes.push(...node.expressions);
    else if (node.type === "not") nodes.push(node.expression);
    else if (node.type === "folder_id") folderIds.add(node.folderId);
    else if (node.type === "assignee" && node.userId) userIds.add(node.userId);
  }
  for (const folderId of folderIds) {
    const [folder] = await params.db<{ id: string }[]>`
      SELECT folder.id
      FROM mail.folders folder
      JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
      WHERE folder.id = ${folderId}::uuid AND resource.mailbox_id = ${params.mailboxId}::uuid
    `;
    if (!folder) return fail(err.badInput("Saved view folder must belong to this mailbox"));
  }
  for (const userId of userIds) {
    const allowed = await hasCurrentMailboxUserPermission({
      mailboxId: params.mailboxId,
      db: params.db,
      userId,
      minimumPermission: "write",
    });
    if (!allowed) return fail(err.badInput("Saved view assignee must have current write access to this mailbox"));
  }
  return ok();
};

const loadVisibleView = async (params: {
  db?: SqlClient;
  mailboxId: string;
  viewId: string;
  userId: string | null;
  forUpdate?: boolean;
}): Promise<SavedViewRow | null> => {
  const db = params.db ?? sql;
  const rows = params.forUpdate
    ? await db<SavedViewRow[]>`
        SELECT ${viewColumns}
        FROM mail.saved_conversation_views
        WHERE id = ${params.viewId}::uuid
          AND mailbox_id = ${params.mailboxId}::uuid
          AND disabled_at IS NULL
          AND (scope = 'mailbox' OR owner_user_id = ${params.userId}::uuid)
        FOR UPDATE
      `
    : await db<SavedViewRow[]>`
        SELECT ${viewColumns}
        FROM mail.saved_conversation_views
        WHERE id = ${params.viewId}::uuid
          AND mailbox_id = ${params.mailboxId}::uuid
          AND disabled_at IS NULL
          AND (scope = 'mailbox' OR owner_user_id = ${params.userId}::uuid)
      `;
  return rows[0] ?? null;
};

export const listSavedConversationViews = async (params: {
  context: MailRequestContext;
  mailboxId: string;
}): Promise<Result<SavedConversationView[]>> => {
  const allowed = await lockMailboxForCollaboration(params.context, params.mailboxId, "read", sql);
  if (!allowed.ok) return allowed;
  const userId = userBackedActor(params.context)?.id ?? null;
  const rows = await sql<SavedViewRow[]>`
    SELECT ${viewColumns}
    FROM mail.saved_conversation_views
    WHERE mailbox_id = ${params.mailboxId}::uuid
      AND disabled_at IS NULL
      AND (scope = 'mailbox' OR owner_user_id = ${userId}::uuid)
    ORDER BY CASE scope WHEN 'private' THEN 0 ELSE 1 END, lower(name), id
  `;
  const views: SavedConversationView[] = [];
  for (const row of rows) {
    const view = mapView(row);
    if (!view.ok) return view;
    views.push(view.data);
  }
  return ok(await withCurrentReferences(views, sql));
};

export const getSavedConversationView = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  viewId: string;
}): Promise<Result<SavedConversationView>> => {
  const allowed = await lockMailboxForCollaboration(params.context, params.mailboxId, "read", sql);
  if (!allowed.ok) return allowed;
  const row = await loadVisibleView({
    mailboxId: params.mailboxId,
    viewId: params.viewId,
    userId: userBackedActor(params.context)?.id ?? null,
  });
  return row ? mapCurrentView(row, sql) : fail(err.notFound("Saved conversation view"));
};

export const createSavedConversationView = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: CreateSavedConversationView;
}): Promise<Result<SavedConversationView>> => {
  const ownerUserId = params.input.scope === "private" ? (userBackedActor(params.context)?.id ?? null) : null;
  if (params.input.scope === "private" && !ownerUserId) {
    return fail(err.forbidden("Private saved views require a user-backed actor"));
  }
  try {
    return await sql.begin(async (tx): Promise<Result<SavedConversationView>> => {
      const allowed = await lockMailboxForCollaboration(
        params.context,
        params.mailboxId,
        params.input.scope === "mailbox" ? "write" : "read",
        tx,
      );
      if (!allowed.ok) return allowed;
      const references = await validateFilterReferences({ db: tx, mailboxId: params.mailboxId, filter: params.input.filter });
      if (!references.ok) return references;
      const actor = actorIdentity(params.context);
      const rows = await withShortIdDb(
        tx,
        "savedView",
        (db, shortId) => db<SavedViewRow[]>`
        INSERT INTO mail.saved_conversation_views (
          short_id, mailbox_id, scope, owner_user_id, name, filter, created_by_kind, created_by_id
        ) VALUES (
          ${shortId},
          ${params.mailboxId}::uuid,
          ${params.input.scope},
          ${ownerUserId}::uuid,
          ${params.input.name},
          ${params.input.filter}::jsonb,
          ${actor.kind},
          ${actor.id}::uuid
        )
        RETURNING ${viewColumns}
      `,
      );
      const [row] = rows;
      if (!row) return fail(err.internal("Saved conversation view insert returned no row"));
      if (row.scope === "mailbox") {
        await insertViewActivity({
          db: tx,
          context: params.context,
          mailboxId: params.mailboxId,
          viewId: row.id,
          action: "conversation_view.created",
          metadata: { scope: row.scope, name: row.name },
        });
      }
      return mapCurrentView(row, tx);
    });
  } catch (error) {
    return isUniqueViolation(error)
      ? fail(err.conflict("A saved view with this name already exists in this scope"))
      : fail(err.internal("Failed to create saved conversation view"));
  }
};

export const updateSavedConversationView = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  viewId: string;
  input: UpdateSavedConversationView;
}): Promise<Result<SavedConversationView>> => {
  try {
    return await sql.begin(async (tx): Promise<Result<SavedConversationView>> => {
      const read = await lockMailboxForCollaboration(params.context, params.mailboxId, "read", tx);
      if (!read.ok) return read;
      const userId = userBackedActor(params.context)?.id ?? null;
      const current = await loadVisibleView({
        db: tx,
        mailboxId: params.mailboxId,
        viewId: params.viewId,
        userId,
        forUpdate: true,
      });
      if (!current) return fail(err.notFound("Saved conversation view"));
      if (current.scope === "mailbox") {
        const write = await lockMailboxForCollaboration(params.context, params.mailboxId, "write", tx);
        if (!write.ok) return write;
      }
      if (Number(current.revision) !== params.input.expectedRevision) {
        return fail(err.conflict("Saved conversation view was changed by another request"));
      }
      const currentFilter = parseFilter(current.filter);
      if (!currentFilter.ok) return currentFilter;
      const filter = params.input.filter ?? currentFilter.data;
      const references = await validateFilterReferences({ db: tx, mailboxId: params.mailboxId, filter });
      if (!references.ok) return references;
      const revision = Number(current.revision) + 1;
      const [row] = await tx<SavedViewRow[]>`
        UPDATE mail.saved_conversation_views
        SET name = ${params.input.name ?? current.name}, filter = ${filter}::jsonb, revision = ${revision}
        WHERE id = ${current.id}::uuid
        RETURNING ${viewColumns}
      `;
      if (!row) return fail(err.internal("Updated saved conversation view could not be loaded"));
      if (row.scope === "mailbox") {
        await insertViewActivity({
          db: tx,
          context: params.context,
          mailboxId: params.mailboxId,
          viewId: row.id,
          action: "conversation_view.updated",
          metadata: { scope: row.scope, name: row.name, revision },
        });
      }
      return mapCurrentView(row, tx);
    });
  } catch (error) {
    return isUniqueViolation(error)
      ? fail(err.conflict("A saved view with this name already exists in this scope"))
      : fail(err.internal("Failed to update saved conversation view"));
  }
};

export const deleteSavedConversationView = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  viewId: string;
  expectedRevision: number;
}): Promise<Result<{ id: string }>> => {
  try {
    return await sql.begin(async (tx): Promise<Result<{ id: string }>> => {
      const read = await lockMailboxForCollaboration(params.context, params.mailboxId, "read", tx);
      if (!read.ok) return read;
      const current = await loadVisibleView({
        db: tx,
        mailboxId: params.mailboxId,
        viewId: params.viewId,
        userId: userBackedActor(params.context)?.id ?? null,
        forUpdate: true,
      });
      if (!current) return fail(err.notFound("Saved conversation view"));
      if (current.scope === "mailbox") {
        const write = await lockMailboxForCollaboration(params.context, params.mailboxId, "write", tx);
        if (!write.ok) return write;
      }
      if (Number(current.revision) !== params.expectedRevision) {
        return fail(err.conflict("Saved conversation view was changed by another request"));
      }
      if (current.scope === "mailbox") {
        await insertViewActivity({
          db: tx,
          context: params.context,
          mailboxId: params.mailboxId,
          viewId: current.id,
          action: "conversation_view.deleted",
          metadata: { scope: current.scope, name: current.name, revision: Number(current.revision) },
        });
      }
      await tx`DELETE FROM mail.saved_conversation_views WHERE id = ${current.id}::uuid`;
      return ok({ id: current.id });
    });
  } catch {
    return fail(err.internal("Failed to delete saved conversation view"));
  }
};

export const listSavedViewConversations = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  viewId: string;
  cursor?: string;
  limit?: number;
}) => {
  const view = await getSavedConversationView(params);
  if (!view.ok) return view;
  const result = await search.searchMessages({
    context: params.context,
    mailboxId: params.mailboxId,
    request: {
      ...view.data.filter,
      cursor: params.cursor,
      limit: params.limit ?? 50,
    },
  });
  if (!result.ok) return result;
  return ok({
    nextCursor: result.data.nextCursor,
    items: result.data.items.map((item) => ({
      id: item.conversationId ?? item.id,
      primaryReference: item.primaryReference,
      subject: item.subject,
      participantSummary: item.participantSummary,
      participantLabels: item.participantLabels,
      latestMessageAt: item.latestMessageAt,
      workStatus: item.workStatus ?? "needs_action",
      assigneeUserIds: item.assigneeUserIds,
      snoozedUntil: item.snoozedUntil,
      revision: item.revision,
      updatedAt: item.updatedAt,
      unread: item.unread,
      activeFolderIds: item.activeFolderIds,
      flagged: item.flagged,
      hasAttachments: item.hasAttachments,
      messageCount: item.messageCount,
      preview: item.snippet,
      folderId: item.sourceFolderId,
      unreadFolderIds: item.unreadFolderIds,
    })),
  });
};
