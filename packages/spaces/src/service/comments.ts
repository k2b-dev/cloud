import { type DateContext, type PageParams, type Paginated, paginate } from "@k2b/stdlib";
import { sql } from "bun";
import * as activity from "./activity";
import type { MutationResult, SpaceComment } from "@/contracts";
import { withShortId } from "../lib/short-id";
import { publishSpaceEvent } from "./events";
import { resolveRecurringOccurrence } from "./recurrence";

// ==========================
// Comments Service
// ==========================

type DbComment = {
  id: string;
  item_id: string;
  recurrence_id: Date | null;
  user_id: string | null;
  user_name: string | null;
  user_avatar_hash?: string | null;
  content: string;
  created_at: Date;
  updated_at: Date;
};

type SqlExecutor = typeof sql;

export const COMMENT_MUTATION_WINDOW_MS = 10 * 60 * 1000;

const isValidOccurrenceScope = async (db: SqlExecutor, itemId: string, recurrenceId: string, dateConfig?: DateContext) => {
  const [item] = await db<
    {
      id: string;
      title: string;
      starts_at: Date | null;
      ends_at: Date | null;
      all_day: boolean;
      recurrence_rrule: string | null;
      recurrence_dtstart: Date | null;
      recurrence_exdate: Date[] | null;
      recurring_event_id: string | null;
    }[]
  >`
    SELECT id, title, starts_at, ends_at, all_day, recurrence_rrule, recurrence_dtstart, recurrence_exdate, recurring_event_id
    FROM spaces.items
    WHERE id = ${itemId}
    FOR SHARE
  `;
  if (!item?.starts_at || !item.ends_at || !item.recurrence_rrule || item.recurring_event_id) return false;

  return Boolean(
    resolveRecurringOccurrence({
      event: {
        id: item.id,
        title: item.title,
        start: item.starts_at,
        end: item.ends_at,
        allDay: item.all_day,
        recurrence: {
          rrule: item.recurrence_rrule,
          dtstart: item.recurrence_dtstart ?? item.starts_at,
          exdate: item.recurrence_exdate ?? [],
        },
      },
      recurrenceId,
      dateConfig,
    }),
  );
};

const canMutateComment = (row: Pick<DbComment, "user_id" | "created_at">, viewerUserId?: string | null) => {
  if (!viewerUserId || row.user_id !== viewerUserId) return false;
  return Date.now() - row.created_at.getTime() <= COMMENT_MUTATION_WINDOW_MS;
};

/**
 * Converts one joined comment row (including optional author name) to `SpaceComment`.
 */
const mapToComment = (row: DbComment, viewerUserId?: string | null): SpaceComment => ({
  id: row.id,
  itemId: row.item_id,
  recurrenceId: row.recurrence_id?.toISOString() ?? null,
  userId: row.user_id,
  userName: row.user_name,
  userAvatarHash: row.user_avatar_hash ?? null,
  content: row.content,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  canEdit: canMutateComment(row, viewerUserId),
  canDelete: canMutateComment(row, viewerUserId),
});

/**
 * Lists one bounded page of comments. Rows are fetched newest-first so page 1
 * always contains the current conversation tail, then reversed for display.
 */
export const list = async (params: {
  itemId: string;
  recurrenceId?: string | null;
  viewerUserId?: string | null;
  pagination?: PageParams;
  query?: string;
}): Promise<Paginated<SpaceComment>> => {
  const { page, perPage, offset } = paginate(params.pagination ?? { page: 1, perPage: 50 });
  const query = params.query?.trim();
  const pattern = query ? `%${query}%` : null;
  const recurrenceId = params.recurrenceId ?? null;
  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM spaces.comments c
    WHERE c.item_id = ${params.itemId}
      AND c.recurrence_id IS NOT DISTINCT FROM ${recurrenceId}::timestamptz
      AND (${pattern}::text IS NULL OR c.content ILIKE ${pattern})
  `;
  const rows = await sql<DbComment[]>`
    SELECT c.id, c.item_id, c.recurrence_id, c.user_id, u.display_name AS user_name, u.avatar_hash AS user_avatar_hash,
           c.content, c.created_at, c.updated_at
    FROM spaces.comments c
    LEFT JOIN auth.users u ON c.user_id = u.id
    WHERE c.item_id = ${params.itemId}
      AND c.recurrence_id IS NOT DISTINCT FROM ${recurrenceId}::timestamptz
      AND (${pattern}::text IS NULL OR c.content ILIKE ${pattern})
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ${perPage}
    OFFSET ${offset}
  `;
  const total = countRow?.count ?? 0;
  return {
    items: rows.reverse().map((row) => mapToComment(row, params.viewerUserId)),
    page,
    perPage,
    total,
    hasNext: page * perPage < total,
  };
};

/**
 * Get a comment by ID
 */
export const get = async (
  params: { id: string; viewerUserId?: string | null },
  db: SqlExecutor = sql,
  lock = false,
): Promise<SpaceComment | null> => {
  const [row] = lock
    ? await db<DbComment[]>`
        SELECT c.id, c.item_id, c.recurrence_id, c.user_id, u.display_name AS user_name, u.avatar_hash AS user_avatar_hash,
               c.content, c.created_at, c.updated_at
        FROM spaces.comments c
        LEFT JOIN auth.users u ON c.user_id = u.id
        WHERE c.id = ${params.id}
        FOR UPDATE OF c
      `
    : await db<DbComment[]>`
        SELECT c.id, c.item_id, c.recurrence_id, c.user_id, u.display_name AS user_name, u.avatar_hash AS user_avatar_hash,
               c.content, c.created_at, c.updated_at
        FROM spaces.comments c
        LEFT JOIN auth.users u ON c.user_id = u.id
        WHERE c.id = ${params.id}
      `;
  return row ? mapToComment(row, params.viewerUserId) : null;
};

/**
 * Create a new comment
 */
export const create = async (params: {
  itemId: string;
  recurrenceId?: string | null;
  dateConfig?: DateContext;
  userId: string;
  content: string;
}): Promise<MutationResult<SpaceComment>> => {
  const { itemId, userId, content } = params;
  const recurrenceId = params.recurrenceId ?? null;

  const inserted = await withShortId("comment", (shortId) =>
    sql.begin(async (tx): Promise<MutationResult<{ row: DbComment; spaceId: string }>> => {
      let item: { space_id: string; title: string } | undefined;
      if (recurrenceId) {
        if (!(await isValidOccurrenceScope(tx, itemId, recurrenceId, params.dateConfig))) {
          return { ok: false, error: "Recurring occurrence not found", status: 404 };
        }
      }
      [item] = await tx<{ space_id: string; title: string }[]>`
        SELECT space_id, title FROM spaces.items WHERE id = ${itemId} FOR SHARE
      `;
      if (!item) return { ok: false, error: "Item not found", status: 404 };

      const [row] = await tx<DbComment[]>`
      INSERT INTO spaces.comments (short_id, item_id, recurrence_id, user_id, content)
      VALUES (${shortId}, ${itemId}, ${recurrenceId}, ${userId}, ${content})
      RETURNING id, item_id, recurrence_id, user_id, content, created_at, updated_at
    `;
      if (!row) return { ok: false, error: "Failed to create comment", status: 500 };
      await activity.record(
        {
          spaceId: item.space_id,
          itemId,
          actor: { kind: "user", id: userId },
          action: "comment.created",
          metadata: { itemTitle: item.title },
        },
        tx,
      );
      return { ok: true, data: { row, spaceId: item.space_id } };
    }),
  );
  if (!inserted.ok) return inserted;

  const row = inserted.data.row;
  // Get user name
  const [user] = await sql<{ display_name: string; avatar_hash: string | null }[]>`
    SELECT display_name, avatar_hash FROM auth.users WHERE id = ${userId}
  `;
  await publishSpaceEvent({ type: "item.updated", spaceId: inserted.data.spaceId, itemId });

  return {
    ok: true,
    data: {
      ...mapToComment(row, userId),
      userName: user?.display_name ?? null,
      userAvatarHash: user?.avatar_hash ?? null,
    },
  };
};

/**
 * Update a comment
 */
export const update = async (params: { id: string; content: string; userId: string }): Promise<MutationResult<SpaceComment>> => {
  const { id, content, userId } = params;
  const result = await sql.begin(async (tx): Promise<MutationResult<{ row: DbComment; existing: SpaceComment; spaceId: string }>> => {
    const existing = await get({ id, viewerUserId: userId }, tx, true);
    if (!existing) return { ok: false, error: "Comment not found", status: 404 };
    if (existing.userId !== userId) return { ok: false, error: "Cannot edit another user's comment", status: 403 };
    if (!existing.canEdit) return { ok: false, error: "Comments can only be edited within 10 minutes", status: 403 };
    const [row] = await tx<DbComment[]>`
      UPDATE spaces.comments SET content = ${content}, updated_at = now()
      WHERE id = ${id} AND user_id = ${userId}::uuid AND created_at >= now() - interval '10 minutes'
      RETURNING id, item_id, recurrence_id, user_id, content, created_at, updated_at
    `;
    if (!row) return { ok: false, error: "Comments can only be edited within 10 minutes", status: 403 };
    const [item] = await tx<{ space_id: string; title: string }[]>`
      SELECT space_id, title FROM spaces.items WHERE id = ${existing.itemId} FOR SHARE
    `;
    if (!item) return { ok: false, error: "Item not found", status: 404 };
    await activity.record(
      {
        spaceId: item.space_id,
        itemId: existing.itemId,
        actor: { kind: "user", id: userId },
        action: "comment.updated",
        metadata: { itemTitle: item.title },
        bucketStartedAt: new Date(new Date().setUTCMinutes(0, 0, 0)),
      },
      tx,
    );
    return { ok: true, data: { row, existing, spaceId: item.space_id } };
  });
  if (!result.ok) return result;
  await publishSpaceEvent({ type: "item.updated", spaceId: result.data.spaceId, itemId: result.data.existing.itemId });

  return {
    ok: true,
    data: {
      ...mapToComment(result.data.row, userId),
      userName: result.data.existing.userName,
      userAvatarHash: result.data.existing.userAvatarHash,
    },
  };
};

/**
 * Delete a comment
 */
export const remove = async (params: { id: string; userId: string }): Promise<MutationResult<void>> => {
  const { id, userId } = params;
  const result = await sql.begin(async (tx): Promise<MutationResult<{ itemId: string; spaceId: string }>> => {
    const existing = await get({ id, viewerUserId: userId }, tx, true);
    if (!existing) return { ok: false, error: "Comment not found", status: 404 };
    if (existing.userId !== userId) return { ok: false, error: "Cannot delete another user's comment", status: 403 };
    if (!existing.canDelete) return { ok: false, error: "Comments can only be deleted within 10 minutes", status: 403 };
    const [item] = await tx<{ space_id: string; title: string }[]>`
      SELECT space_id, title FROM spaces.items WHERE id = ${existing.itemId} FOR SHARE
    `;
    if (!item) return { ok: false, error: "Item not found", status: 404 };
    const [deleted] = await tx<{ id: string }[]>`
      DELETE FROM spaces.comments
      WHERE id = ${id} AND user_id = ${userId}::uuid AND created_at >= now() - interval '10 minutes'
      RETURNING id
    `;
    if (!deleted) return { ok: false, error: "Comments can only be deleted within 10 minutes", status: 403 };
    await activity.record(
      {
        spaceId: item.space_id,
        itemId: existing.itemId,
        actor: { kind: "user", id: userId },
        action: "comment.deleted",
        metadata: { itemTitle: item.title },
      },
      tx,
    );
    return { ok: true, data: { itemId: existing.itemId, spaceId: item.space_id } };
  });
  if (!result.ok) return result;
  await publishSpaceEvent({ type: "item.updated", spaceId: result.data.spaceId, itemId: result.data.itemId });

  return { ok: true, data: undefined };
};
