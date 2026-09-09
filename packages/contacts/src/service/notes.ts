import { err, fail, ok, type PageParams, type Paginated, paginate, type Result } from "@k2b/stdlib";
import { capabilityIdempotencyConflict } from "@k2b/cloud/contracts";
import { sql } from "bun";
import { newShortId, withShortId, withShortIdRetry } from "../lib/short-id";
import { isUuid, type SqlExecutor } from "./shared";
import type { ContactNote, CreateContactNoteInput, UpdateContactNoteInput } from "./types";

type DbContactNote = {
  id: string;
  contact_id: string;
  author_user_id: string | null;
  author_display_name: string;
  author_avatar_hash: string | null;
  content: string;
  created_at: Date;
  updated_at: Date;
};

const MAX_CONTENT_LENGTH = 10_000;
export const NOTE_MUTATION_WINDOW_MS = 10 * 60 * 1000;

const canMutateNote = (row: Pick<DbContactNote, "author_user_id" | "created_at">, viewerUserId?: string | null): boolean =>
  Boolean(viewerUserId && row.author_user_id === viewerUserId && Date.now() - row.created_at.getTime() <= NOTE_MUTATION_WINDOW_MS);

const mapNote = (row: DbContactNote, viewerUserId?: string | null): ContactNote => {
  const canMutate = canMutateNote(row, viewerUserId);
  return {
    id: row.id,
    contactId: row.contact_id,
    authorUserId: row.author_user_id,
    authorDisplayName: row.author_display_name,
    authorAvatarHash: row.author_avatar_hash,
    content: row.content,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    canEdit: canMutate,
    canDelete: canMutate,
  };
};

const verifyContactInBook = async (config: { bookId: string; contactId: string; db?: SqlExecutor }): Promise<boolean> => {
  if (!isUuid(config.bookId) || !isUuid(config.contactId)) return false;
  const db = config.db ?? sql;
  const [row] = await db<{ id: string }[]>`
    SELECT id FROM contacts.contacts
    WHERE id = ${config.contactId}::uuid
      AND book_id = ${config.bookId}::uuid
  `;
  return !!row;
};

const loadNote = async (config: {
  noteId: string;
  contactId: string;
  viewerUserId?: string | null;
  db?: SqlExecutor;
}): Promise<ContactNote | null> => {
  const db = config.db ?? sql;
  const [row] = await db<DbContactNote[]>`
    SELECT n.id, n.contact_id, n.author_user_id, n.author_display_name, u.avatar_hash AS author_avatar_hash, n.content, n.created_at, n.updated_at
    FROM contacts.contact_notes n
    LEFT JOIN auth.users u ON u.id = n.author_user_id
    WHERE n.id = ${config.noteId}::uuid AND n.contact_id = ${config.contactId}::uuid
  `;
  return row ? mapNote(row, config.viewerUserId) : null;
};

export const get = async (config: { id: string; viewerUserId?: string | null }): Promise<ContactNote | null> => {
  if (!isUuid(config.id)) return null;
  const [row] = await sql<DbContactNote[]>`
    SELECT n.id, n.contact_id, n.author_user_id, n.author_display_name, u.avatar_hash AS author_avatar_hash, n.content, n.created_at, n.updated_at
    FROM contacts.contact_notes n
    LEFT JOIN auth.users u ON u.id = n.author_user_id
    WHERE n.id = ${config.id}::uuid
  `;
  return row ? mapNote(row, config.viewerUserId) : null;
};

/**
 * Lists notes for one contact in chronological order (newest first).
 * Caller must already have read access to the contact's book.
 */
export const list = async (config: { bookId: string; contactId: string; viewerUserId?: string | null }): Promise<ContactNote[]> => {
  if (!(await verifyContactInBook(config))) return [];

  const rows = await sql<DbContactNote[]>`
    SELECT n.id, n.contact_id, n.author_user_id, n.author_display_name, u.avatar_hash AS author_avatar_hash, n.content, n.created_at, n.updated_at
    FROM contacts.contact_notes n
    LEFT JOIN auth.users u ON u.id = n.author_user_id
    WHERE n.contact_id = ${config.contactId}::uuid
    ORDER BY n.created_at DESC
  `;
  return rows.map((row) => mapNote(row, config.viewerUserId));
};

/** Lists a bounded page of notes newest first. */
export const listPage = async (config: {
  bookId: string;
  contactId: string;
  viewerUserId?: string | null;
  pagination?: PageParams;
}): Promise<Paginated<ContactNote>> => {
  const { page, perPage, offset } = paginate(config.pagination);
  if (!(await verifyContactInBook(config))) return { items: [], page, perPage, total: 0, hasNext: false };

  const [[countRow], rows] = await Promise.all([
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM contacts.contact_notes WHERE contact_id = ${config.contactId}::uuid
    `,
    sql<DbContactNote[]>`
      SELECT n.id, n.contact_id, n.author_user_id, n.author_display_name, u.avatar_hash AS author_avatar_hash, n.content, n.created_at, n.updated_at
      FROM contacts.contact_notes n
      LEFT JOIN auth.users u ON u.id = n.author_user_id
      WHERE n.contact_id = ${config.contactId}::uuid
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ${perPage}
      OFFSET ${offset}
    `,
  ]);
  const total = countRow?.count ?? 0;
  return { items: rows.map((row) => mapNote(row, config.viewerUserId)), page, perPage, total, hasNext: page * perPage < total };
};

/**
 * Appends one note to a contact. Author identity is snapshotted so the note
 * stays readable if the user account is later removed.
 */
export const create = async (config: {
  bookId: string;
  contactId: string;
  authorUserId: string;
  authorDisplayName: string;
  data: CreateContactNoteInput;
}): Promise<Result<ContactNote>> => {
  const trimmed = config.data.content.trim();
  if (!trimmed) return fail(err.badInput("Note content is required"));
  if (trimmed.length > MAX_CONTENT_LENGTH) {
    return fail(err.badInput(`Note must be ${MAX_CONTENT_LENGTH} characters or fewer`));
  }
  if (!(await verifyContactInBook(config))) return fail(err.notFound("Contact"));

  const row = await withShortId("note", async (shortId) => {
    const [created] = await sql<DbContactNote[]>`
      WITH inserted AS (
        INSERT INTO contacts.contact_notes (
          short_id,
          contact_id,
          author_user_id,
          author_display_name,
          content
        ) VALUES (
          ${shortId},
          ${config.contactId}::uuid,
          ${config.authorUserId}::uuid,
          ${config.authorDisplayName},
          ${trimmed}
        )
        RETURNING id, contact_id, author_user_id, author_display_name, content, created_at, updated_at
      )
      SELECT i.id, i.contact_id, i.author_user_id, i.author_display_name, u.avatar_hash AS author_avatar_hash, i.content, i.created_at, i.updated_at
      FROM inserted i
      LEFT JOIN auth.users u ON u.id = i.author_user_id
    `;
    return created;
  });
  if (!row) return fail(err.internal("Failed to create note"));
  return ok(mapNote(row, config.authorUserId));
};

/** Creates one note exactly once with the claim and note in one transaction. */
export const createIdempotent = async (config: {
  bookId: string;
  contactId: string;
  authorUserId: string;
  authorDisplayName: string;
  data: CreateContactNoteInput;
  actorKey: string;
  actionId: string;
  idempotencyKeyHash: string;
  requestHash: string;
}): Promise<Result<{ note: ContactNote; replayed: boolean }>> => {
  const trimmed = config.data.content.trim();
  if (!trimmed) return fail(err.badInput("Note content is required"));
  if (trimmed.length > MAX_CONTENT_LENGTH) return fail(err.badInput(`Note must be ${MAX_CONTENT_LENGTH} characters or fewer`));
  if (!isUuid(config.authorUserId)) return fail(err.forbidden("A user identity is required to create notes"));

  return withShortIdRetry(["note"], () =>
    sql.begin(async (tx): Promise<Result<{ note: ContactNote; replayed: boolean }>> => {
      const shortId = newShortId();
      if (!(await verifyContactInBook({ ...config, db: tx }))) return fail(err.notFound("Contact"));
      const [allocated] = await tx<{ id: string }[]>`SELECT gen_random_uuid() AS id`;
      if (!allocated) return fail(err.internal("Failed to allocate note id"));

      const [claim] = await tx<{ contact_id: string }[]>`
      INSERT INTO contacts.capability_action_results (
        actor_key, action_id, idempotency_key_hash, request_hash, contact_id, result_label
      ) VALUES (
        ${config.actorKey}, ${config.actionId}, ${config.idempotencyKeyHash}, ${config.requestHash},
        ${config.contactId}::uuid, ${allocated.id}
      )
      ON CONFLICT (actor_key, action_id, idempotency_key_hash) DO NOTHING
      RETURNING contact_id
    `;
      if (!claim) {
        const [existing] = await tx<{ request_hash: string; contact_id: string; result_label: string }[]>`
        SELECT request_hash, contact_id, result_label
        FROM contacts.capability_action_results
        WHERE actor_key = ${config.actorKey}
          AND action_id = ${config.actionId}
          AND idempotency_key_hash = ${config.idempotencyKeyHash}
      `;
        if (!existing) return fail(err.internal("Idempotency replay lookup failed"));
        if (existing.request_hash !== config.requestHash) {
          return fail(capabilityIdempotencyConflict("Idempotency-Key was already used with different input"));
        }
        if (!isUuid(existing.result_label) || existing.contact_id !== config.contactId) {
          return fail(err.internal("Stored idempotency result is invalid"));
        }
        const note = await loadNote({
          noteId: existing.result_label,
          contactId: config.contactId,
          viewerUserId: config.authorUserId,
          db: tx,
        });
        return note ? ok({ note, replayed: true }) : fail(err.conflict("The note created by this idempotency key no longer exists"));
      }

      await tx`
      INSERT INTO contacts.contact_notes (id, short_id, contact_id, author_user_id, author_display_name, content)
      VALUES (${allocated.id}::uuid, ${shortId}, ${config.contactId}::uuid, ${config.authorUserId}::uuid, ${config.authorDisplayName}, ${trimmed})
    `;
      const note = await loadNote({ noteId: allocated.id, contactId: config.contactId, viewerUserId: config.authorUserId, db: tx });
      return note ? ok({ note, replayed: false }) : fail(err.internal("Failed to load created note"));
    }),
  );
};

/**
 * Updates one note's content within the author's mutation window.
 */
export const update = async (config: {
  bookId: string;
  contactId: string;
  noteId: string;
  authorUserId: string;
  data: UpdateContactNoteInput;
}): Promise<Result<ContactNote>> => {
  const trimmed = config.data.content.trim();
  if (!trimmed) return fail(err.badInput("Note content is required"));
  if (trimmed.length > MAX_CONTENT_LENGTH) {
    return fail(err.badInput(`Note must be ${MAX_CONTENT_LENGTH} characters or fewer`));
  }
  if (!isUuid(config.noteId)) return fail(err.notFound("Note"));
  if (!(await verifyContactInBook(config))) return fail(err.notFound("Contact"));

  const [existing] = await sql<{ author_user_id: string | null; created_at: Date }[]>`
    SELECT author_user_id, created_at FROM contacts.contact_notes
    WHERE id = ${config.noteId}::uuid
      AND contact_id = ${config.contactId}::uuid
  `;
  if (!existing) return fail(err.notFound("Note"));
  if (existing.author_user_id !== config.authorUserId) {
    return fail(err.forbidden("Only the author may edit this note"));
  }
  if (!canMutateNote(existing, config.authorUserId)) {
    return fail(err.forbidden("Notes can only be edited within 10 minutes"));
  }

  const [row] = await sql<DbContactNote[]>`
    WITH updated AS (
      UPDATE contacts.contact_notes
      SET content = ${trimmed}, updated_at = now()
      WHERE id = ${config.noteId}::uuid
        AND author_user_id = ${config.authorUserId}::uuid
        AND created_at >= now() - interval '10 minutes'
      RETURNING id, contact_id, author_user_id, author_display_name, content, created_at, updated_at
    )
    SELECT u2.id, u2.contact_id, u2.author_user_id, u2.author_display_name, au.avatar_hash AS author_avatar_hash, u2.content, u2.created_at, u2.updated_at
    FROM updated u2
    LEFT JOIN auth.users au ON au.id = u2.author_user_id
  `;
  if (!row) return fail(err.forbidden("Notes can only be edited within 10 minutes"));
  return ok(mapNote(row, config.authorUserId));
};

/**
 * Deletes one note within the author's mutation window.
 */
export const remove = async (config: {
  bookId: string;
  contactId: string;
  noteId: string;
  authorUserId: string;
}): Promise<Result<void>> => {
  if (!isUuid(config.noteId)) return fail(err.notFound("Note"));
  if (!(await verifyContactInBook(config))) return fail(err.notFound("Contact"));

  const [existing] = await sql<{ author_user_id: string | null; created_at: Date }[]>`
    SELECT author_user_id, created_at FROM contacts.contact_notes
    WHERE id = ${config.noteId}::uuid
      AND contact_id = ${config.contactId}::uuid
  `;
  if (!existing) return fail(err.notFound("Note"));
  if (existing.author_user_id !== config.authorUserId) return fail(err.forbidden("Only the author may delete this note"));
  if (!canMutateNote(existing, config.authorUserId)) return fail(err.forbidden("Notes can only be deleted within 10 minutes"));

  const [deleted] = await sql<{ id: string }[]>`
    DELETE FROM contacts.contact_notes
    WHERE id = ${config.noteId}::uuid
      AND author_user_id = ${config.authorUserId}::uuid
      AND created_at >= now() - interval '10 minutes'
    RETURNING id
  `;
  if (!deleted) return fail(err.forbidden("Notes can only be deleted within 10 minutes"));
  return ok(undefined);
};
