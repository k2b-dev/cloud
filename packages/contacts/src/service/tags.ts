import { err, fail, ok, type PageParams, type Paginated, paginate, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { withShortId } from "../lib/short-id";
import { publishContactChange } from "./live";
import { isUuid, type SqlExecutor, toPgUuidArray } from "./shared";
import type { ContactTag, CreateContactTagInput, UpdateContactTagInput } from "./types";

type DbTag = {
  id: string;
  book_id: string;
  name: string;
  color: string;
  created_at: Date;
  updated_at: Date;
};

const mapTag = (row: DbTag): ContactTag => ({
  id: row.id,
  bookId: row.book_id,
  name: row.name,
  color: row.color,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const validateInput = (input: { name?: string; color?: string }): Result<void> => {
  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (trimmed.length === 0) return fail(err.badInput("Tag name is required"));
    if (trimmed.length > 50) return fail(err.badInput("Tag name must be 50 characters or fewer"));
  }
  if (input.color !== undefined && !HEX_COLOR.test(input.color)) {
    return fail(err.badInput("Tag color must be a #RRGGBB hex value"));
  }
  return ok(undefined);
};

/** Lists all tags belonging to one book, alphabetical by name. */
export const list = async (config: { bookId: string }): Promise<ContactTag[]> => {
  if (!isUuid(config.bookId)) return [];
  const rows = await sql<DbTag[]>`
    SELECT id, book_id, name, color, created_at, updated_at
    FROM contacts.tags
    WHERE book_id = ${config.bookId}::uuid
    ORDER BY LOWER(name) ASC
  `;
  return rows.map(mapTag);
};

export const get = async (config: { id: string }): Promise<ContactTag | null> => {
  if (!isUuid(config.id)) return null;
  const [row] = await sql<DbTag[]>`
    SELECT id, book_id, name, color, created_at, updated_at
    FROM contacts.tags
    WHERE id = ${config.id}::uuid
  `;
  return row ? mapTag(row) : null;
};

/** Lists one bounded page of tags for capability and API consumers. */
export const listPage = async (config: { bookId: string; pagination?: PageParams }): Promise<Paginated<ContactTag>> => {
  const { page, perPage, offset } = paginate(config.pagination);
  if (!isUuid(config.bookId)) return { items: [], page, perPage, total: 0, hasNext: false };

  const [[countRow], rows] = await Promise.all([
    sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM contacts.tags WHERE book_id = ${config.bookId}::uuid`,
    sql<DbTag[]>`
      SELECT id, book_id, name, color, created_at, updated_at
      FROM contacts.tags
      WHERE book_id = ${config.bookId}::uuid
      ORDER BY LOWER(name) ASC, id ASC
      LIMIT ${perPage}
      OFFSET ${offset}
    `,
  ]);
  const total = countRow?.count ?? 0;
  return { items: rows.map(mapTag), page, perPage, total, hasNext: page * perPage < total };
};

/** Lists the combined tag vocabulary for a set of already-authorized books. */
export const listForBooks = async (config: { bookIds: string[] }): Promise<ContactTag[]> => {
  const bookIds = [...new Set(config.bookIds)];
  if (bookIds.length === 0 || bookIds.some((bookId) => !isUuid(bookId))) return [];
  const rows = await sql<DbTag[]>`
    SELECT id, book_id, name, color, created_at, updated_at
    FROM contacts.tags
    WHERE book_id = ANY(${toPgUuidArray(bookIds)}::uuid[])
    ORDER BY LOWER(name) ASC, book_id ASC, id ASC
  `;
  return rows.map(mapTag);
};

export const create = async (config: { bookId: string; data: CreateContactTagInput }): Promise<Result<ContactTag>> => {
  const validation = validateInput(config.data);
  if (!validation.ok) return validation;
  if (!isUuid(config.bookId)) return fail(err.notFound("Book"));

  try {
    const row = await withShortId("tag", (shortId) =>
      sql.begin(async (tx) => {
        const [created] = await tx<DbTag[]>`
          INSERT INTO contacts.tags (short_id, book_id, name, color)
          VALUES (${shortId}, ${config.bookId}::uuid, ${config.data.name.trim()}, ${config.data.color})
          RETURNING id, book_id, name, color, created_at, updated_at
        `;
        if (created) await publishContactChange(tx, { type: "tags.changed", bookId: config.bookId });
        return created;
      }),
    );
    if (!row) return fail(err.internal("Failed to create tag"));
    return ok(mapTag(row));
  } catch (error) {
    // PG error 23505 = unique_violation. The (book_id, name) unique constraint
    // hits when the user re-creates a tag with an existing name.
    // Bun's sql client surfaces the SQLSTATE on `errno`; older versions of the
    // same client (and other parts of this repo) read it from `code`. Check
    // both so the conflict response works regardless of runtime version.
    if (isObject(error) && (error["errno"] === "23505" || error["code"] === "23505")) {
      return fail(err.conflict("Tag with that name"));
    }
    throw error;
  }
};

export const update = async (config: { bookId: string; id: string; data: UpdateContactTagInput }): Promise<Result<ContactTag>> => {
  const validation = validateInput(config.data);
  if (!validation.ok) return validation;
  if (!isUuid(config.bookId) || !isUuid(config.id)) return fail(err.notFound("Tag"));

  const [existing] = await sql<DbTag[]>`
    SELECT id, book_id, name, color, created_at, updated_at
    FROM contacts.tags
    WHERE id = ${config.id}::uuid AND book_id = ${config.bookId}::uuid
  `;
  if (!existing) return fail(err.notFound("Tag"));

  const nextName = config.data.name === undefined ? existing.name : config.data.name.trim();
  const nextColor = config.data.color === undefined ? existing.color : config.data.color;

  try {
    const row = await sql.begin(async (tx) => {
      const [updated] = await tx<DbTag[]>`
        UPDATE contacts.tags
        SET name = ${nextName}, color = ${nextColor}, updated_at = now()
        WHERE id = ${config.id}::uuid AND book_id = ${config.bookId}::uuid
        RETURNING id, book_id, name, color, created_at, updated_at
      `;
      if (updated) await publishContactChange(tx, { type: "tags.changed", bookId: config.bookId });
      return updated;
    });
    if (!row) return fail(err.internal("Failed to update tag"));
    return ok(mapTag(row));
  } catch (error) {
    // Bun's sql client surfaces the SQLSTATE on `errno`; older versions of the
    // same client (and other parts of this repo) read it from `code`. Check
    // both so the conflict response works regardless of runtime version.
    if (isObject(error) && (error["errno"] === "23505" || error["code"] === "23505")) {
      return fail(err.conflict("Tag with that name"));
    }
    throw error;
  }
};

export const remove = async (config: { bookId: string; id: string }): Promise<Result<void>> => {
  if (!isUuid(config.bookId) || !isUuid(config.id)) return fail(err.notFound("Tag"));
  const row = await sql.begin(async (tx) => {
    const [deleted] = await tx<{ id: string }[]>`
      DELETE FROM contacts.tags
      WHERE id = ${config.id}::uuid AND book_id = ${config.bookId}::uuid
      RETURNING id
    `;
    if (deleted) await publishContactChange(tx, { type: "tags.changed", bookId: config.bookId });
    return deleted;
  });
  if (!row) return fail(err.notFound("Tag"));
  return ok(undefined);
};

/**
 * Validates that every id in `tagIds` is a UUID belonging to `bookId`. Used
 * by the contact upsert flow to guard tag assignment BEFORE the contact row
 * is inserted/updated, so a bad tag list cannot leave a half-persisted
 * contact behind.
 *
 * Returns the deduplicated, validated id list on success.
 */
export const validateTagsInBook = async (config: { bookId: string; tagIds: string[] }): Promise<Result<string[]>> => {
  const deduplicatedIds = Array.from(new Set(config.tagIds));
  const validIds = deduplicatedIds.filter(isUuid);
  if (validIds.length !== deduplicatedIds.length) {
    return fail(err.badInput("Tag ids must be UUIDs"));
  }
  if (validIds.length === 0) return ok([]);

  const found = await sql<{ id: string }[]>`
    SELECT id FROM contacts.tags
    WHERE id = ANY(${toPgUuidArray(validIds)}::uuid[])
      AND book_id = ${config.bookId}::uuid
  `;
  if (found.length !== validIds.length) {
    return fail(err.badInput("One or more tags do not belong to this book"));
  }
  return ok(validIds);
};

/**
 * Replaces all tag assignments for a contact. The caller MUST have validated
 * the tag ids beforehand via `validateTagsInBook`; this function trusts its
 * inputs and only writes.
 */
const replaceAssignmentsWithDb = async (config: { contactId: string; tagIds: string[]; db: SqlExecutor }): Promise<void> => {
  const db = config.db;
  await db`DELETE FROM contacts.contact_tag_assignments WHERE contact_id = ${config.contactId}::uuid`;
  if (config.tagIds.length === 0) return;
  for (const tagId of config.tagIds) {
    await db`
      INSERT INTO contacts.contact_tag_assignments (contact_id, tag_id)
      VALUES (${config.contactId}::uuid, ${tagId}::uuid)
      ON CONFLICT DO NOTHING
    `;
  }
};

export const replaceAssignments = async (config: { contactId: string; tagIds: string[]; db?: SqlExecutor }): Promise<void> => {
  if (config.db) {
    await replaceAssignmentsWithDb({ ...config, db: config.db });
    return;
  }
  await sql.begin((tx) => replaceAssignmentsWithDb({ ...config, db: tx }));
};

/** Atomically adds and removes book-scoped tags from one contact. */
export const changeAssignments = async (config: {
  bookId: string;
  contactId: string;
  addTagIds: string[];
  removeTagIds: string[];
}): Promise<Result<ContactTag[]>> => {
  if (!isUuid(config.bookId) || !isUuid(config.contactId)) return fail(err.notFound("Contact"));
  const addTagIds = [...new Set(config.addTagIds)];
  const removeTagIds = [...new Set(config.removeTagIds)];
  if ([...addTagIds, ...removeTagIds].some((id) => !isUuid(id))) return fail(err.badInput("Tag ids must be UUIDs"));
  if (addTagIds.some((id) => removeTagIds.includes(id))) {
    return fail(err.badInput("A tag cannot be added and removed in the same change"));
  }

  return sql.begin(async (tx): Promise<Result<ContactTag[]>> => {
    const [contact] = await tx<{ id: string }[]>`
      SELECT id FROM contacts.contacts
      WHERE id = ${config.contactId}::uuid AND book_id = ${config.bookId}::uuid
      FOR UPDATE
    `;
    if (!contact) return fail(err.notFound("Contact"));

    const requested = [...new Set([...addTagIds, ...removeTagIds])];
    if (requested.length > 0) {
      const found = await tx<{ id: string }[]>`
        SELECT id FROM contacts.tags
        WHERE book_id = ${config.bookId}::uuid
          AND id = ANY(${toPgUuidArray(requested)}::uuid[])
      `;
      if (found.length !== requested.length) return fail(err.badInput("One or more tags do not belong to this book"));
    }

    if (removeTagIds.length > 0) {
      await tx`
        DELETE FROM contacts.contact_tag_assignments
        WHERE contact_id = ${config.contactId}::uuid
          AND tag_id = ANY(${toPgUuidArray(removeTagIds)}::uuid[])
      `;
    }
    for (const tagId of addTagIds) {
      await tx`
        INSERT INTO contacts.contact_tag_assignments (contact_id, tag_id)
        VALUES (${config.contactId}::uuid, ${tagId}::uuid)
        ON CONFLICT DO NOTHING
      `;
    }

    const rows = await tx<DbTag[]>`
      SELECT t.id, t.book_id, t.name, t.color, t.created_at, t.updated_at
      FROM contacts.tags t
      JOIN contacts.contact_tag_assignments assignment ON assignment.tag_id = t.id
      WHERE assignment.contact_id = ${config.contactId}::uuid
      ORDER BY LOWER(t.name) ASC, t.id ASC
    `;
    await publishContactChange(tx, { type: "contact.updated", bookId: config.bookId, contactId: config.contactId });
    return ok(rows.map(mapTag));
  });
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
