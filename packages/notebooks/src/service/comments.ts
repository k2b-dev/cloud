import { err, fail, ok, type PageParams, type Paginated, paginate, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { generateUniqueShortId } from "../lib/short-id";
import * as activity from "./activity";
import * as workspaceEvents from "./workspace-events";

export const COMMENT_CONTENT_MAX_LENGTH = 5_000;
export const COMMENT_MUTATION_WINDOW_MS = 10 * 60 * 1000;

export type NoteComment = {
  id: string;
  shortId: string;
  noteId: string;
  authorUserId: string | null;
  authorDisplayName: string;
  authorAvatarHash: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  canDelete: boolean;
};

type DbNoteComment = {
  id: string;
  short_id: string;
  note_id: string;
  author_user_id: string | null;
  author_display_name: string;
  author_avatar_hash: string | null;
  content: string;
  created_at: Date;
  updated_at: Date;
};

export const canMutateComment = (
  comment: { authorUserId: string | null; createdAt: string | Date },
  viewerUserId?: string | null,
  now = Date.now(),
): boolean =>
  Boolean(
    viewerUserId && comment.authorUserId === viewerUserId && now - new Date(comment.createdAt).getTime() <= COMMENT_MUTATION_WINDOW_MS,
  );

const mapComment = (row: DbNoteComment, viewerUserId?: string | null): NoteComment => {
  const mutable = canMutateComment({ authorUserId: row.author_user_id, createdAt: row.created_at }, viewerUserId);
  return {
    id: row.id,
    shortId: row.short_id,
    noteId: row.note_id,
    authorUserId: row.author_user_id,
    authorDisplayName: row.author_display_name,
    authorAvatarHash: row.author_avatar_hash,
    content: row.content,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    canEdit: mutable,
    canDelete: mutable,
  };
};

const verifyNoteInNotebook = async (config: { notebookId: string; noteId: string }): Promise<boolean> => {
  const [row] = await sql<{ id: string }[]>`
    SELECT id
    FROM notebooks.notes
    WHERE id = ${config.noteId}::uuid
      AND notebook_id = ${config.notebookId}::uuid
  `;
  return Boolean(row);
};

export const getByShortId = async (config: { shortId: string; viewerUserId?: string | null }): Promise<NoteComment | null> => {
  const [row] = await sql<DbNoteComment[]>`
    SELECT
      comment.id,
      comment.short_id,
      comment.note_id,
      comment.author_user_id,
      comment.author_display_name,
      author.avatar_hash AS author_avatar_hash,
      comment.content,
      comment.created_at,
      comment.updated_at
    FROM notebooks.note_comments comment
    LEFT JOIN auth.users author ON author.id = comment.author_user_id
    WHERE comment.short_id = ${config.shortId}
  `;
  return row ? mapComment(row, config.viewerUserId) : null;
};

/** Lists a bounded page newest first. Consumers reverse loaded pages for chronological display. */
export const listPage = async (config: {
  notebookId: string;
  noteId: string;
  viewerUserId?: string | null;
  pagination?: PageParams;
  offset?: number;
}): Promise<Paginated<NoteComment>> => {
  const { page, perPage, offset: pageOffset } = paginate(config.pagination ?? { page: 1, perPage: 30 });
  const offset = config.offset ?? pageOffset;
  if (!(await verifyNoteInNotebook(config))) return { items: [], page, perPage, total: 0, hasNext: false };

  const [[countRow], rows] = await Promise.all([
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM notebooks.note_comments
      WHERE note_id = ${config.noteId}::uuid
    `,
    sql<DbNoteComment[]>`
      SELECT
        comment.id,
        comment.short_id,
        comment.note_id,
        comment.author_user_id,
        comment.author_display_name,
        author.avatar_hash AS author_avatar_hash,
        comment.content,
        comment.created_at,
        comment.updated_at
      FROM notebooks.note_comments comment
      LEFT JOIN auth.users author ON author.id = comment.author_user_id
      WHERE comment.note_id = ${config.noteId}::uuid
      ORDER BY comment.created_at DESC, comment.id DESC
      LIMIT ${perPage}
      OFFSET ${offset}
    `,
  ]);
  const total = countRow?.count ?? 0;
  return {
    items: rows.map((row) => mapComment(row, config.viewerUserId)),
    page,
    perPage,
    total,
    hasNext: offset + rows.length < total,
  };
};

const validateContent = (content: string): Result<string> => {
  const trimmed = content.trim();
  if (!trimmed) return fail(err.badInput("Comment content is required"));
  if (trimmed.length > COMMENT_CONTENT_MAX_LENGTH) {
    return fail(err.badInput(`Comment must be ${COMMENT_CONTENT_MAX_LENGTH} characters or fewer`));
  }
  return ok(trimmed);
};

export const create = async (config: {
  notebookId: string;
  noteId: string;
  authorUserId: string;
  authorDisplayName: string;
  content: string;
}): Promise<Result<NoteComment>> => {
  const content = validateContent(config.content);
  if (!content.ok) return content;
  if (!(await verifyNoteInNotebook(config))) return fail(err.notFound("Note"));

  const shortId = await generateUniqueShortId("comment");
  const [row] = await sql<DbNoteComment[]>`
    WITH inserted AS (
      INSERT INTO notebooks.note_comments (short_id, note_id, author_user_id, author_display_name, content)
      VALUES (${shortId}, ${config.noteId}::uuid, ${config.authorUserId}::uuid, ${config.authorDisplayName}, ${content.data})
      RETURNING id, short_id, note_id, author_user_id, author_display_name, content, created_at, updated_at
    )
    SELECT
      inserted.id,
      inserted.short_id,
      inserted.note_id,
      inserted.author_user_id,
      inserted.author_display_name,
      author.avatar_hash AS author_avatar_hash,
      inserted.content,
      inserted.created_at,
      inserted.updated_at
    FROM inserted
    LEFT JOIN auth.users author ON author.id = inserted.author_user_id
  `;
  if (!row) return fail(err.internal("Failed to create comment"));

  await Promise.all([
    activity.record({
      notebookId: config.notebookId,
      noteId: config.noteId,
      actor: { kind: "user", id: config.authorUserId },
      action: "comment.created",
      metadata: { commentId: row.short_id },
    }),
    workspaceEvents.noteCommentsChanged({ notebookId: config.notebookId, noteId: config.noteId }),
  ]);
  return ok(mapComment(row, config.authorUserId));
};

export const update = async (config: {
  notebookId: string;
  noteId: string;
  commentId: string;
  authorUserId: string;
  content: string;
}): Promise<Result<NoteComment>> => {
  const content = validateContent(config.content);
  if (!content.ok) return content;
  if (!(await verifyNoteInNotebook(config))) return fail(err.notFound("Note"));

  const existing = await getByShortId({ shortId: config.commentId, viewerUserId: config.authorUserId });
  if (!existing || existing.noteId !== config.noteId) return fail(err.notFound("Comment"));
  if (existing.authorUserId !== config.authorUserId) return fail(err.forbidden("Only the author may edit this comment"));
  if (!existing.canEdit) return fail(err.forbidden("Comments can only be edited within 10 minutes"));

  const [row] = await sql<DbNoteComment[]>`
    WITH updated AS (
      UPDATE notebooks.note_comments
      SET content = ${content.data}, updated_at = now()
      WHERE id = ${existing.id}::uuid
        AND note_id = ${config.noteId}::uuid
        AND author_user_id = ${config.authorUserId}::uuid
        AND created_at >= now() - interval '10 minutes'
      RETURNING id, short_id, note_id, author_user_id, author_display_name, content, created_at, updated_at
    )
    SELECT
      updated.id,
      updated.short_id,
      updated.note_id,
      updated.author_user_id,
      updated.author_display_name,
      author.avatar_hash AS author_avatar_hash,
      updated.content,
      updated.created_at,
      updated.updated_at
    FROM updated
    LEFT JOIN auth.users author ON author.id = updated.author_user_id
  `;
  if (!row) return fail(err.forbidden("Comments can only be edited within 10 minutes"));

  await Promise.all([
    activity.record({
      notebookId: config.notebookId,
      noteId: config.noteId,
      actor: { kind: "user", id: config.authorUserId },
      action: "comment.updated",
      metadata: { commentId: row.short_id },
    }),
    workspaceEvents.noteCommentsChanged({ notebookId: config.notebookId, noteId: config.noteId }),
  ]);
  return ok(mapComment(row, config.authorUserId));
};

export const remove = async (config: {
  notebookId: string;
  noteId: string;
  commentId: string;
  authorUserId: string;
}): Promise<Result<void>> => {
  if (!(await verifyNoteInNotebook(config))) return fail(err.notFound("Note"));
  const existing = await getByShortId({ shortId: config.commentId, viewerUserId: config.authorUserId });
  if (!existing || existing.noteId !== config.noteId) return fail(err.notFound("Comment"));
  if (existing.authorUserId !== config.authorUserId) return fail(err.forbidden("Only the author may delete this comment"));
  if (!existing.canDelete) return fail(err.forbidden("Comments can only be deleted within 10 minutes"));

  const [deleted] = await sql<{ id: string }[]>`
    DELETE FROM notebooks.note_comments
    WHERE id = ${existing.id}::uuid
      AND note_id = ${config.noteId}::uuid
      AND author_user_id = ${config.authorUserId}::uuid
      AND created_at >= now() - interval '10 minutes'
    RETURNING id
  `;
  if (!deleted) return fail(err.forbidden("Comments can only be deleted within 10 minutes"));

  await Promise.all([
    activity.record({
      notebookId: config.notebookId,
      noteId: config.noteId,
      actor: { kind: "user", id: config.authorUserId },
      action: "comment.deleted",
      metadata: { commentId: existing.shortId },
    }),
    workspaceEvents.noteCommentsChanged({ notebookId: config.notebookId, noteId: config.noteId }),
  ]);
  return ok(undefined);
};
