import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { sql } from "bun";
import type { PulseSavedQuery } from "../contracts";
import { withShortId } from "../lib/short-id";
import { compilePulseQueryText } from "../query-dsl";
import { type AccessScope, requireBaseAccess, requireBaseActive, userIdForScope } from "./access-control";
import { resolveBasePublicId } from "./public-resources";
import { iso } from "./telemetry-values";

type SavedQueryRow = {
  id: string;
  base_id: string;
  name: string;
  description: string | null;
  query: string;
  created_at: Date | string;
  updated_at: Date | string;
};

const mapSavedQuery = (row: SavedQueryRow): PulseSavedQuery => ({
  id: row.id,
  baseId: row.base_id,
  name: row.name,
  description: row.description,
  query: row.query,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

export const listSavedQueries = async (
  baseId: string,
  user: AccessScope,
  params: { query?: string | null; limit?: number; offset?: number } = {},
): Promise<Result<PulseSavedQuery[]>> => {
  const access = await requireBaseAccess(baseId, user, "read");
  if (!access.ok) return fail(access.error);
  const query = params.query?.trim() || null;
  const pattern = query ? `%${query.replace(/([\\%_])/g, "\\$1")}%` : null;
  const limit = Math.min(100, Math.max(1, params.limit ?? 100));
  const offset = Math.max(0, params.offset ?? 0);
  const rows = await sql<SavedQueryRow[]>`
    SELECT id, base_id, name, description, query, created_at, updated_at
    FROM pulse.saved_queries
    WHERE base_id = ${baseId}::uuid
      AND (${pattern}::text IS NULL OR name ILIKE ${pattern} ESCAPE '\\' OR description ILIKE ${pattern} ESCAPE '\\')
    ORDER BY updated_at DESC, name ASC, id ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return ok(rows.map(mapSavedQuery));
};

export const getSavedQuery = async (baseId: string, queryId: string, user: AccessScope): Promise<Result<PulseSavedQuery>> => {
  const access = await requireBaseAccess(baseId, user, "read");
  if (!access.ok) return fail(access.error);
  const [row] = await sql<SavedQueryRow[]>`
    SELECT id, base_id, name, description, query, created_at, updated_at
    FROM pulse.saved_queries
    WHERE base_id = ${baseId}::uuid
      AND id = ${queryId}::uuid
  `;
  return row ? ok(mapSavedQuery(row)) : fail(err.notFound("Saved query"));
};

export const readSavedQuery = async (queryId: string, user: AccessScope): Promise<Result<PulseSavedQuery>> => {
  const [row] = await sql<SavedQueryRow[]>`
    SELECT id, base_id, name, description, query, created_at, updated_at
    FROM pulse.saved_queries
    WHERE id = ${queryId}::uuid
  `;
  if (!row) return fail(err.notFound("Saved query"));
  const access = await requireBaseAccess(row.base_id, user, "read");
  return access.ok ? ok(mapSavedQuery(row)) : fail(access.error);
};

export const createSavedQuery = async (params: {
  baseId: string;
  user: AccessScope;
  name: string;
  description?: string | null;
  query: string;
}): Promise<Result<PulseSavedQuery>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "write");
  if (!access.ok) return fail(access.error);
  const active = await requireBaseActive(params.baseId);
  if (!active.ok) return fail(active.error);
  const name = params.name.trim();
  const query = params.query.trim();
  if (!name) return fail(err.badInput("Query name is required"));
  if (!query) return fail(err.badInput("Query is required"));
  const compiled = compilePulseQueryText(params.baseId, query);
  if (!compiled.ok) return fail(compiled.error);
  if (compiled.data.sourceId && !(await resolveBasePublicId("sources", params.baseId, compiled.data.sourceId))) {
    return fail(err.badInput("Query references an unknown Source ID"));
  }
  const row = await withShortId("saved_query", async (shortId) => {
    const [created] = await sql<SavedQueryRow[]>`
      INSERT INTO pulse.saved_queries (short_id, base_id, name, description, query, created_by)
      VALUES (${shortId}, ${params.baseId}::uuid, ${name}, ${params.description?.trim() || null}, ${query}, ${userIdForScope(params.user)}::uuid)
      RETURNING id, base_id, name, description, query, created_at, updated_at
    `;
    return created;
  });
  if (!row) return fail(err.internal("Failed to save query"));
  return ok(mapSavedQuery(row));
};

export const deleteSavedQuery = async (params: { baseId: string; queryId: string; user: AccessScope }): Promise<Result<void>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "write");
  if (!access.ok) return fail(access.error);
  const active = await requireBaseActive(params.baseId);
  if (!active.ok) return fail(active.error);
  const deleted = await sql`
    DELETE FROM pulse.saved_queries
    WHERE base_id = ${params.baseId}::uuid
      AND id = ${params.queryId}::uuid
  `;
  if (deleted.count === 0) return fail(err.notFound("Saved query"));
  return ok();
};
