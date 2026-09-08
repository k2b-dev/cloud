import { err, fail, ok, type Result } from "@k2b/stdlib";
import { type AccessSubject, buildAccessPrincipalTierConditions } from "@valentinkolb/cloud/server";
import { sql } from "bun";
import { DocumentDefaultsSchema } from "../contracts";
import { grantAccess } from "./access";
import { logAudit } from "./audit";
import { getGridsCrudMessages } from "./crud-messages";
import { degradeForSourceBaseChange, refreshForSourceBase } from "./federated-tables";
import { parseJsonbRow } from "./jsonb";
import { emitMetadataEvent } from "./metadata-events";
import { insertWithShortId } from "./short-id";
import type { Base, CreateBaseInput, UpdateBaseInput } from "./types";

type DbRow = Record<string, unknown>;

const COLS = sql`id, short_id, name, description, document_defaults, created_by, deleted_at, created_at, updated_at`;

const mapDocumentDefaults = (value: unknown): Base["documentDefaults"] => {
  return DocumentDefaultsSchema.parse(parseJsonbRow(value, {}));
};

const mapRow = (row: DbRow): Base => ({
  id: row.id as string,
  shortId: row.short_id as string,
  name: row.name as string,
  description: (row.description as string | null) ?? null,
  documentDefaults: mapDocumentDefaults(row.document_defaults),
  createdBy: (row.created_by as string | null) ?? null,
  deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
  createdAt: (row.created_at as Date).toISOString(),
  updatedAt: (row.updated_at as Date).toISOString(),
});

/**
 * Lists active (non-soft-deleted) bases. Pass `includeDeleted: true`
 * to include trashed entries — used by the trash/restore UI.
 */
export const list = async (opts: { includeDeleted?: boolean } = {}): Promise<Base[]> => {
  const rows = opts.includeDeleted
    ? await sql<DbRow[]>`
        SELECT ${COLS}
        FROM grids.bases
        ORDER BY created_at DESC
      `
    : await sql<DbRow[]>`
        SELECT ${COLS}
        FROM grids.bases
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC
      `;
  return rows.map(mapRow);
};

export const listVisible = async (params: {
  userId: string | null;
  userGroups: string[];
  serviceAccountId?: string | null;
  baseId?: string;
  query?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: Base[]; total: number }> => {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);
  const query = params.query?.trim().toLowerCase();
  const conditions: any[] = [sql`b.deleted_at IS NULL`];
  if (params.baseId) conditions.push(sql`b.id = ${params.baseId}::uuid`);
  if (query) {
    const pattern = `%${escapeLikePattern(query)}%`;
    conditions.push(sql`(
      LOWER(b.name) LIKE ${pattern} ESCAPE '\\'
      OR LOWER(COALESCE(b.description, '')) LIKE ${pattern} ESCAPE '\\'
      OR LOWER(b.short_id) LIKE ${pattern} ESCAPE '\\'
    )`);
  }
  const where = conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);

  const serviceAccountId = params.serviceAccountId ?? null;
  const subject: AccessSubject | null = params.userId
    ? { type: "user", userId: params.userId }
    : serviceAccountId
      ? { type: "service_account", serviceAccountId }
      : null;
  const principalTiers = buildAccessPrincipalTierConditions({
    subject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });
  const permissionRank = sql`CASE a.permission WHEN 'read' THEN 1 WHEN 'write' THEN 2 WHEN 'admin' THEN 3 ELSE 0 END`;
  const rankFor = (principal: "serviceAccount" | "user" | "group" | "authenticated" | "public") => {
    const principalWhere = principalTiers[principal];
    return sql`(
      SELECT CASE
        WHEN COUNT(*) = 0 THEN NULL
        WHEN bool_or(a.permission = 'none') THEN 0
        ELSE MAX(${permissionRank})
      END
      FROM grids.base_access ba
      JOIN auth.access a ON a.id = ba.access_id
      WHERE ba.base_id = b.id AND ${principalWhere}
    )`;
  };

  const ranked = () => sql`
    SELECT b.*,
      ${rankFor("serviceAccount")} AS service_account_rank,
      ${rankFor("user")} AS user_rank,
      ${rankFor("group")} AS group_rank,
      ${rankFor("authenticated")} AS auth_rank,
      ${rankFor("public")} AS public_rank
    FROM grids.bases b
    WHERE ${where}
  `;
  const visibleWhere = sql`COALESCE(service_account_rank, user_rank, group_rank, auth_rank, public_rank, 0) >= 1`;
  const [countRow] = await sql<{ total: number }[]>`
    SELECT COUNT(*)::int AS total
    FROM (${ranked()}) visible
    WHERE ${visibleWhere}
  `;
  const rows = await sql<DbRow[]>`
    SELECT *
    FROM (${ranked()}) visible
    WHERE ${visibleWhere}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return { items: rows.map(mapRow), total: countRow?.total ?? 0 };
};

/**
 * Returns the base or null. Soft-deleted bases return null by default —
 * callers that need to render the trash listing or perform restore must
 * pass `includeDeleted: true`.
 */
export const get = async (id: string, opts: { includeDeleted?: boolean; client?: typeof sql } = {}): Promise<Base | null> => {
  const client = opts.client ?? sql;
  const [row] = opts.includeDeleted
    ? await client<DbRow[]>`
        SELECT ${COLS}
        FROM grids.bases WHERE id = ${id}::uuid
      `
    : await client<DbRow[]>`
        SELECT ${COLS}
        FROM grids.bases WHERE id = ${id}::uuid AND deleted_at IS NULL
      `;
  return row ? mapRow(row) : null;
};

/** Resolves the only public base identifier to the internal resource. */
export const getByShortId = async (shortId: string): Promise<Base | null> => {
  const [row] = await sql<DbRow[]>`
    SELECT ${COLS}
    FROM grids.bases WHERE short_id = ${shortId} AND deleted_at IS NULL
  `;
  return row ? mapRow(row) : null;
};

export const create = async (input: CreateBaseInput, actorId: string | null, locale?: string): Promise<Result<Base>> => {
  const messages = getGridsCrudMessages(locale);
  const name = input.name.trim();
  if (name.length === 0) return fail(err.badInput(messages.nameRequired));

  const row = await insertWithShortId<DbRow>(async (shortId) => {
    const [r] = await sql<DbRow[]>`
      INSERT INTO grids.bases (short_id, name, description, document_defaults, created_by)
      VALUES (${shortId}, ${name}, ${input.description ?? null}, ${input.documentDefaults ?? {}}::jsonb, ${actorId}::uuid)
      RETURNING ${COLS}
    `;
    if (!r) throw new Error("insert returned no row");
    return r;
  }, "idx_grids_bases_short_id");
  const base = mapRow(row);

  // Auto-grant admin to the creator so they can immediately use the new base.
  // Without this, no ACL row exists and the resolver returns "none" — the
  // creator would lock themselves out at the moment of creation.
  //
  // grantAccess reaches into cloud/services/accounts (auth.access table)
  // so threading a transaction across both apps is a bigger refactor;
  // instead, on failure we rollback the just-created base manually.
  // Imperfect (the cleanup DELETE could itself fail) but strictly better
  // than today's behaviour of leaving the orphan and returning fail.
  if (actorId) {
    const granted = await grantAccess({
      resourceType: "base",
      resourceId: base.id,
      principal: { type: "user", userId: actorId },
      permission: "admin",
      actorId,
    });
    if (!granted.ok) {
      // Hard delete (not soft) — there's no audit value in keeping a
      // base that was never visible to anyone.
      await sql`DELETE FROM grids.bases WHERE id = ${base.id}::uuid`.catch(() => {});
      return fail(granted.error);
    }
  }

  await logAudit({ baseId: base.id, userId: actorId, action: "created" });
  await emitMetadataEvent({
    type: "base.created",
    baseId: base.id,
    resource: { kind: "base", id: base.id },
    actorId,
  });
  return ok(base);
};

export const update = async (id: string, input: UpdateBaseInput, actorId: string | null, locale?: string): Promise<Result<Base>> => {
  const messages = getGridsCrudMessages(locale);
  const existing = await get(id);
  if (!existing) return fail(err.notFound(messages.base));

  const name = input.name?.trim();
  if (name !== undefined && name.length === 0) return fail(err.badInput(messages.nameEmpty));

  const next = {
    name: name ?? existing.name,
    description: input.description !== undefined ? input.description : existing.description,
    documentDefaults: input.documentDefaults !== undefined ? input.documentDefaults : existing.documentDefaults,
  };

  const [row] = await sql<DbRow[]>`
    UPDATE grids.bases
    SET name = ${next.name},
        description = ${next.description},
        document_defaults = ${next.documentDefaults}::jsonb,
        updated_at = now()
    WHERE id = ${id}::uuid AND deleted_at IS NULL
    RETURNING ${COLS}
  `;
  if (!row) return fail(err.internal(messages.updateFailed));
  const base = mapRow(row);

  const diff: Record<string, { old: unknown; new: unknown }> = {};
  if (next.name !== existing.name) diff.name = { old: existing.name, new: next.name };
  if (next.description !== existing.description) {
    diff.description = { old: existing.description, new: next.description };
  }
  if (JSON.stringify(next.documentDefaults) !== JSON.stringify(existing.documentDefaults)) {
    diff.documentDefaults = { old: existing.documentDefaults, new: next.documentDefaults };
  }
  if (Object.keys(diff).length > 0) {
    await logAudit({ baseId: id, userId: actorId, action: "updated", diff });
    await emitMetadataEvent({
      type: "base.updated",
      baseId: id,
      resource: { kind: "base", id },
      actorId,
    });
  }

  return ok(base);
};

/**
 * Soft-deletes the base. The row stays in the DB with `deleted_at` set,
 * which makes it invisible to all default queries (list/get) while
 * keeping its tables/fields/records/views/forms recoverable. The base
 * remains restorable until an explicit product action changes that
 * lifecycle.
 */
export const remove = async (id: string, actorId: string | null, locale?: string): Promise<Result<void>> => {
  const messages = getGridsCrudMessages(locale);
  const removed = await sql.begin(async (tx): Promise<Result<void>> => {
    await degradeForSourceBaseChange(id, actorId, tx);
    const result = await tx`
      UPDATE grids.bases SET deleted_at = now()
      WHERE id = ${id}::uuid AND deleted_at IS NULL
    `;
    if (result.count === 0) return fail(err.notFound(messages.base));
    await logAudit({ baseId: id, userId: actorId, action: "deleted" }, tx);
    return ok();
  });
  if (!removed.ok) return removed;
  await emitMetadataEvent({
    type: "base.deleted",
    baseId: id,
    resource: { kind: "base", id },
    actorId,
  });
  await refreshForSourceBase(id, actorId);
  return ok();
};

/**
 * Restores a soft-deleted base. Children (tables/fields/records/views/forms)
 * that were independently deleted stay deleted — restore is non-cascading
 * by design, matching the user's expectation of "I deleted the base by
 * accident; the table I trashed last week is unrelated".
 */
export const restore = async (id: string, actorId: string | null, locale?: string): Promise<Result<Base>> => {
  const messages = getGridsCrudMessages(locale);
  const restored = await sql.begin(async (tx): Promise<Result<DbRow>> => {
    await degradeForSourceBaseChange(id, actorId, tx);
    const [row] = await tx<DbRow[]>`
      UPDATE grids.bases SET deleted_at = NULL, updated_at = now()
      WHERE id = ${id}::uuid AND deleted_at IS NOT NULL
      RETURNING ${COLS}
    `;
    if (!row) return fail(err.notFound(messages.base));
    await logAudit({ baseId: id, userId: actorId, action: "restored" }, tx);
    return ok(row);
  });
  if (!restored.ok) return restored;
  const row = restored.data;
  const base = mapRow(row);
  await emitMetadataEvent({
    type: "base.restored",
    baseId: id,
    resource: { kind: "base", id },
    actorId,
  });
  await refreshForSourceBase(id, actorId);
  return ok(base);
};

// ──────────────────────────────────────────────────────────────────
// Admin views (platform-admin only — bypasses per-base ACLs)
// ──────────────────────────────────────────────────────────────────

type AdminListItem = Base & {
  tableCount: number;
  recordCount: number;
  accessCount: number;
};

const escapeLikePattern = (s: string): string => s.replace(/([\\%_])/g, "\\$1");

export const adminList = async (params: {
  pagination?: { perPage?: number; offset?: number };
  filter?: { query?: string };
}): Promise<{ items: AdminListItem[]; total: number; page: number; perPage: number }> => {
  const perPage = Math.min(Math.max(params.pagination?.perPage ?? 100, 1), 500);
  const offset = Math.max(params.pagination?.offset ?? 0, 0);
  const page = Math.floor(offset / perPage) + 1;
  const query = params.filter?.query?.trim().toLowerCase();

  const conditions: any[] = [sql`b.deleted_at IS NULL`];
  if (query) {
    const pattern = `%${escapeLikePattern(query)}%`;
    conditions.push(sql`(LOWER(b.name) LIKE ${pattern} ESCAPE '\\' OR LOWER(COALESCE(b.description, '')) LIKE ${pattern} ESCAPE '\\')`);
  }
  const where = conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);

  const [countRow] = await sql<{ total: number }[]>`
    SELECT COUNT(*)::int AS total FROM grids.bases b WHERE ${where}
  `;

  const rows = await sql<DbRow[]>`
    SELECT
      b.id, b.short_id, b.name, b.description, b.document_defaults, b.created_by, b.deleted_at, b.created_at, b.updated_at,
      (SELECT COUNT(*)::int FROM grids.tables WHERE base_id = b.id AND deleted_at IS NULL) AS table_count,
      (SELECT COUNT(*)::int FROM grids.records r JOIN grids.tables t ON t.id = r.table_id WHERE t.base_id = b.id AND t.deleted_at IS NULL AND r.deleted_at IS NULL) AS record_count,
      (SELECT COUNT(*)::int FROM grids.base_access WHERE base_id = b.id) AS access_count
    FROM grids.bases b
    WHERE ${where}
    ORDER BY b.created_at DESC
    LIMIT ${perPage} OFFSET ${offset}
  `;

  return {
    items: rows.map((row) => ({
      ...mapRow(row),
      tableCount: row.table_count as number,
      recordCount: row.record_count as number,
      accessCount: row.access_count as number,
    })),
    total: countRow?.total ?? 0,
    page,
    perPage,
  };
};

export const adminSummary = async (params: {
  filter?: { query?: string };
}): Promise<{ totalBases: number; totalTables: number; totalRecords: number; orphanedBases: number }> => {
  const query = params.filter?.query?.trim().toLowerCase();
  const conditions: any[] = [sql`b.deleted_at IS NULL`];
  if (query) {
    const pattern = `%${escapeLikePattern(query)}%`;
    conditions.push(sql`(LOWER(b.name) LIKE ${pattern} ESCAPE '\\' OR LOWER(COALESCE(b.description, '')) LIKE ${pattern} ESCAPE '\\')`);
  }
  const where = conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);

  const [row] = await sql<DbRow[]>`
    SELECT
      (SELECT COUNT(*)::int FROM grids.bases b WHERE ${where}) AS total_bases,
      (SELECT COUNT(*)::int FROM grids.tables t JOIN grids.bases b ON b.id = t.base_id WHERE t.deleted_at IS NULL AND ${where}) AS total_tables,
      (SELECT COUNT(*)::int FROM grids.records r JOIN grids.tables t ON t.id = r.table_id JOIN grids.bases b ON b.id = t.base_id WHERE r.deleted_at IS NULL AND t.deleted_at IS NULL AND ${where}) AS total_records,
      (SELECT COUNT(*)::int FROM grids.bases b WHERE NOT EXISTS (SELECT 1 FROM grids.base_access WHERE base_id = b.id) AND ${where}) AS orphaned_bases
  `;
  return {
    totalBases: (row?.total_bases as number) ?? 0,
    totalTables: (row?.total_tables as number) ?? 0,
    totalRecords: (row?.total_records as number) ?? 0,
    orphanedBases: (row?.orphaned_bases as number) ?? 0,
  };
};
