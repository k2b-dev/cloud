import { Buffer } from "node:buffer";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { SqlClient } from "./audit";
import { getGridsCrudMessages } from "./crud-messages";
import { type AuthorizedRecordAccess, recordAccessPredicate } from "./record-access";
import { captureRecordEventSnapshot, enqueueRecordEvent, notifyRecordEventOutbox } from "./record-event-outbox";
import { insertWithShortIdForDb } from "./short-id";

const MAX_BODY_LENGTH = 10_000;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

type CommentRow = {
  id: string;
  short_id: string;
  author_user_id: string | null;
  body: string;
  deleted_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  author_display_name: string | null;
  author_avatar_hash: string | null;
};

export type RecordComment = {
  id: string;
  shortId: string;
  authorUserId: string | null;
  authorDisplayName: string;
  authorAvatarHash: string | null;
  body: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RecordCommentPage = { items: RecordComment[]; nextCursor: string | null };

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

const mapRow = (row: CommentRow): RecordComment => ({
  id: row.id,
  shortId: row.short_id,
  authorUserId: row.author_user_id,
  authorDisplayName: row.author_display_name?.trim() || "Former user",
  authorAvatarHash: row.author_avatar_hash,
  body: row.deleted_at ? null : row.body,
  deletedAt: row.deleted_at ? iso(row.deleted_at) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const cursorFor = (comment: RecordComment): string =>
  Buffer.from(JSON.stringify([comment.createdAt, comment.id]), "utf8").toString("base64url");

const parseCursor = (cursor: string | null | undefined): [string, string] | null => {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, id] = parsed;
    if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) return null;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return [createdAt, id];
  } catch {
    return null;
  }
};

const normalizeBody = (body: string, locale?: string): Result<string> => {
  const messages = getGridsCrudMessages(locale);
  const normalized = body.trim();
  if (!normalized) return fail(err.badInput(messages.commentRequired));
  if (normalized.length > MAX_BODY_LENGTH) return fail(err.badInput(messages.commentTooLong({ max: MAX_BODY_LENGTH })));
  return ok(normalized);
};

export const list = async (params: {
  baseId: string;
  tableId: string;
  recordId: string;
  recordAccess: AuthorizedRecordAccess;
  cursor?: string | null;
  limit?: number;
  locale?: string;
}): Promise<Result<RecordCommentPage>> => {
  const messages = getGridsCrudMessages(params.locale);
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const cursor = parseCursor(params.cursor);
  if (params.cursor && !cursor) return fail(err.badInput(messages.invalidCommentCursor));
  const rows = await sql<CommentRow[]>`
    SELECT comment.id::text, comment.short_id,
           comment.author_user_id::text,
           comment.body,
           comment.deleted_at,
           comment.created_at,
           comment.updated_at,
           COALESCE(author.display_name, author.uid) AS author_display_name,
           author.avatar_hash AS author_avatar_hash
    FROM grids.record_comments comment
    JOIN grids.records r
      ON r.id = comment.record_id
     AND r.table_id = comment.table_id
     AND r.deleted_at IS NULL
    JOIN grids.tables table_ref
      ON table_ref.id = r.table_id
     AND table_ref.base_id = comment.base_id
     AND table_ref.deleted_at IS NULL
    JOIN grids.bases base ON base.id = table_ref.base_id AND base.deleted_at IS NULL
    LEFT JOIN auth.users author ON author.id = comment.author_user_id
    WHERE comment.base_id = ${params.baseId}::uuid
      AND comment.table_id = ${params.tableId}::uuid
      AND comment.record_id = ${params.recordId}::uuid
      AND ${recordAccessPredicate(params.recordAccess, "r")}
      AND (${cursor?.[0] ?? null}::timestamptz IS NULL OR (comment.created_at, comment.id) < (${cursor?.[0] ?? null}::timestamptz, ${cursor?.[1] ?? null}::uuid))
    ORDER BY comment.created_at DESC, comment.id DESC
    LIMIT ${limit + 1}
  `;
  const items = rows.slice(0, limit).map(mapRow);
  return ok({ items, nextCursor: rows.length > limit && items.length > 0 ? cursorFor(items[items.length - 1]!) : null });
};

export const create = async (params: {
  baseId: string;
  tableId: string;
  recordId: string;
  actorUserId: string | null;
  body: string;
  recordAccess: AuthorizedRecordAccess;
  locale?: string;
}): Promise<Result<RecordComment>> => {
  const messages = getGridsCrudMessages(params.locale);
  if (!params.actorUserId) return fail(err.forbidden(messages.commentsRequireUser));
  const body = normalizeBody(params.body, params.locale);
  if (!body.ok) return body;

  let outboxId: string | null = null;
  const created = await sql.begin(async (tx): Promise<RecordComment | null> => {
    const row = await insertWithShortIdForDb(tx, "idx_grids_record_comments_short_id", async (attempt, shortId) => {
      const [created] = await attempt<Array<CommentRow & { record_version: number }>>`
      WITH target AS (
        SELECT r.id, r.version, r.table_id, table_ref.base_id
        FROM grids.records r
        JOIN grids.tables table_ref ON table_ref.id = r.table_id AND table_ref.deleted_at IS NULL
        JOIN grids.bases base ON base.id = table_ref.base_id AND base.deleted_at IS NULL
        WHERE r.id = ${params.recordId}::uuid
          AND r.table_id = ${params.tableId}::uuid
          AND table_ref.base_id = ${params.baseId}::uuid
          AND r.deleted_at IS NULL
          AND ${recordAccessPredicate(params.recordAccess, "r")}
      ), inserted AS (
        INSERT INTO grids.record_comments (short_id, base_id, table_id, record_id, author_user_id, body)
        SELECT ${shortId}, base_id, table_id, id, ${params.actorUserId}::uuid, ${body.data}
        FROM target
        RETURNING *
      )
      SELECT inserted.id::text, inserted.short_id,
             inserted.author_user_id::text,
             inserted.body,
             inserted.deleted_at,
             inserted.created_at,
             inserted.updated_at,
             COALESCE(author.display_name, author.uid) AS author_display_name,
             author.avatar_hash AS author_avatar_hash,
             target.version AS record_version
      FROM inserted
      JOIN target ON target.id = inserted.record_id
      LEFT JOIN auth.users author ON author.id = inserted.author_user_id
      `;
      return created ?? null;
    });
    if (!row) return null;
    outboxId = await enqueueRecordEvent(tx as SqlClient, {
      type: "comment.created",
      baseId: params.baseId,
      tableId: params.tableId,
      recordId: params.recordId,
      version: row.record_version,
      changedFieldIds: [],
      actorId: params.actorUserId,
    });
    await captureRecordEventSnapshot(tx as SqlClient, {
      snapshotId: outboxId,
      tableId: params.tableId,
      recordId: params.recordId,
      eventType: "comment.created",
    });
    return mapRow(row);
  });
  if (!created) return fail(err.notFound(messages.record));
  if (outboxId) notifyRecordEventOutbox(outboxId);
  return ok(created);
};

const existingForMutation = async (params: {
  baseId: string;
  tableId: string;
  recordId: string;
  commentId: string;
  recordAccess: AuthorizedRecordAccess;
}) => {
  const [row] = await sql<Array<{ author_user_id: string | null; deleted_at: Date | null }>>`
    SELECT comment.author_user_id::text, comment.deleted_at
    FROM grids.record_comments comment
    JOIN grids.records r
      ON r.id = comment.record_id
     AND r.table_id = comment.table_id
     AND r.deleted_at IS NULL
    JOIN grids.tables table_ref
      ON table_ref.id = r.table_id
     AND table_ref.base_id = comment.base_id
     AND table_ref.deleted_at IS NULL
    JOIN grids.bases base ON base.id = table_ref.base_id AND base.deleted_at IS NULL
    WHERE comment.id = ${params.commentId}::uuid
      AND comment.base_id = ${params.baseId}::uuid
      AND comment.table_id = ${params.tableId}::uuid
      AND comment.record_id = ${params.recordId}::uuid
      AND ${recordAccessPredicate(params.recordAccess, "r")}
  `;
  return row ?? null;
};

const getById = async (params: { tableId: string; recordId: string; commentId: string }): Promise<RecordComment | null> => {
  const [row] = await sql<CommentRow[]>`
    SELECT comment.id::text, comment.short_id,
           comment.author_user_id::text,
           comment.body,
           comment.deleted_at,
           comment.created_at,
           comment.updated_at,
           COALESCE(author.display_name, author.uid) AS author_display_name,
           author.avatar_hash AS author_avatar_hash
    FROM grids.record_comments comment
    LEFT JOIN auth.users author ON author.id = comment.author_user_id
    WHERE comment.id = ${params.commentId}::uuid
      AND comment.table_id = ${params.tableId}::uuid
      AND comment.record_id = ${params.recordId}::uuid
  `;
  return row ? mapRow(row) : null;
};

/** Resolves the only public comment identifier to a live internal comment. */
export const getByShortId = async (shortId: string): Promise<RecordComment | null> => {
  const [row] = await sql<CommentRow[]>`
    SELECT comment.id::text, comment.short_id, comment.author_user_id::text,
           comment.body, comment.deleted_at, comment.created_at, comment.updated_at,
           COALESCE(author.display_name, author.uid) AS author_display_name,
           author.avatar_hash AS author_avatar_hash
    FROM grids.record_comments comment
    JOIN grids.records record ON record.id = comment.record_id AND record.deleted_at IS NULL
    JOIN grids.tables table_ref ON table_ref.id = record.table_id AND table_ref.deleted_at IS NULL
    JOIN grids.bases base ON base.id = table_ref.base_id AND base.deleted_at IS NULL
    LEFT JOIN auth.users author ON author.id = comment.author_user_id
    WHERE comment.short_id = ${shortId}
  `;
  return row ? mapRow(row) : null;
};

export const update = async (params: {
  baseId: string;
  tableId: string;
  recordId: string;
  commentId: string;
  actorUserId: string | null;
  canModerate: boolean;
  body: string;
  recordAccess: AuthorizedRecordAccess;
  locale?: string;
}): Promise<Result<RecordComment>> => {
  const messages = getGridsCrudMessages(params.locale);
  if (!params.actorUserId) return fail(err.forbidden(messages.commentsRequireUser));
  const body = normalizeBody(params.body, params.locale);
  if (!body.ok) return body;
  const existing = await existingForMutation(params);
  if (!existing || existing.deleted_at) return fail(err.notFound(messages.comment));
  if (!params.canModerate && existing.author_user_id !== params.actorUserId) return fail(err.forbidden(messages.editOwnComments));
  const result = await sql`
    UPDATE grids.record_comments
    SET body = ${body.data}, updated_at = now()
    WHERE id = ${params.commentId}::uuid
      AND table_id = ${params.tableId}::uuid
      AND record_id = ${params.recordId}::uuid
      AND deleted_at IS NULL
  `;
  if (result.count !== 1) return fail(err.notFound(messages.comment));
  const updated = await getById(params);
  return updated ? ok(updated) : fail(err.notFound(messages.comment));
};

export const remove = async (params: {
  baseId: string;
  tableId: string;
  recordId: string;
  commentId: string;
  actorUserId: string | null;
  canModerate: boolean;
  recordAccess: AuthorizedRecordAccess;
  locale?: string;
}): Promise<Result<void>> => {
  const messages = getGridsCrudMessages(params.locale);
  if (!params.actorUserId) return fail(err.forbidden(messages.commentsRequireUser));
  const existing = await existingForMutation(params);
  if (!existing || existing.deleted_at) return fail(err.notFound(messages.comment));
  if (!params.canModerate && existing.author_user_id !== params.actorUserId) return fail(err.forbidden(messages.deleteOwnComments));
  const result = await sql`
    UPDATE grids.record_comments
    SET deleted_at = now(), updated_at = now()
    WHERE id = ${params.commentId}::uuid
      AND table_id = ${params.tableId}::uuid
      AND record_id = ${params.recordId}::uuid
      AND deleted_at IS NULL
  `;
  return result.count === 1 ? ok() : fail(err.notFound(messages.comment));
};
