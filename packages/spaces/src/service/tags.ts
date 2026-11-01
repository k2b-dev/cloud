import { sql } from "@k2b/cloud";
import type { CreateTag, MutationResult, SpaceTag, UpdateTag } from "@/contracts";
import { withShortId } from "../lib/short-id";

// ==========================
// Tags Service
// ==========================

type DbTag = {
  id: string;
  space_id: string;
  name: string;
  color: string;
};

/**
 * Converts one tag row from `spaces.tags` into the API-facing `SpaceTag` model.
 */
const mapToTag = (row: DbTag): SpaceTag => ({
  id: row.id,
  spaceId: row.space_id,
  name: row.name,
  color: row.color,
});

/**
 * List tags for a space
 */
export const list = async (params: { spaceId: string }): Promise<SpaceTag[]> => {
  const rows = await sql<DbTag[]>`
    SELECT id, space_id, name, color
    FROM spaces.tags
    WHERE space_id = ${params.spaceId}
    ORDER BY name
  `;
  return rows.map(mapToTag);
};

/**
 * Get a tag by ID
 */
export const get = async (params: { id: string }): Promise<SpaceTag | null> => {
  const [row] = await sql<DbTag[]>`
    SELECT id, space_id, name, color
    FROM spaces.tags
    WHERE id = ${params.id}
  `;
  return row ? mapToTag(row) : null;
};

/**
 * Create a new tag
 */
export const create = async (params: { spaceId: string; data: CreateTag }): Promise<MutationResult<SpaceTag>> => {
  const { spaceId, data } = params;

  // Check for duplicate name
  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM spaces.tags
    WHERE space_id = ${spaceId} AND name = ${data.name}
  `;

  if (existing) {
    return {
      ok: false,
      error: "Tag with this name already exists",
      status: 400,
    };
  }

  const row = await withShortId("tag", async (shortId) => {
    const [created] = await sql<DbTag[]>`
      INSERT INTO spaces.tags (short_id, space_id, name, color)
      VALUES (${shortId}, ${spaceId}, ${data.name}, ${data.color})
      RETURNING id, space_id, name, color
    `;
    return created;
  });

  if (!row) {
    return { ok: false, error: "Failed to create tag", status: 500 };
  }

  return { ok: true, data: mapToTag(row) };
};

/**
 * Update a tag
 */
export const update = async (params: { id: string; data: UpdateTag }): Promise<MutationResult<SpaceTag>> => {
  const { id, data } = params;

  const existing = await get({ id });
  if (!existing) {
    return { ok: false, error: "Tag not found", status: 404 };
  }

  const name = data.name ?? existing.name;
  const color = data.color ?? existing.color;

  // Check for duplicate name if changing
  if (data.name && data.name !== existing.name) {
    const [duplicate] = await sql<{ id: string }[]>`
      SELECT id FROM spaces.tags
      WHERE space_id = ${existing.spaceId} AND name = ${data.name} AND id != ${id}
    `;
    if (duplicate) {
      return {
        ok: false,
        error: "Tag with this name already exists",
        status: 400,
      };
    }
  }

  const [row] = await sql<DbTag[]>`
    UPDATE spaces.tags
    SET name = ${name}, color = ${color}
    WHERE id = ${id}
    RETURNING id, space_id, name, color
  `;

  if (!row) {
    return { ok: false, error: "Failed to update tag", status: 500 };
  }

  return { ok: true, data: mapToTag(row) };
};

/**
 * Delete a tag
 */
export const remove = async (params: { id: string }): Promise<MutationResult<void>> => {
  const result = await sql`
    DELETE FROM spaces.tags
    WHERE id = ${params.id}
  `;

  if (result.count === 0) {
    return { ok: false, error: "Tag not found", status: 404 };
  }

  return { ok: true, data: undefined };
};
