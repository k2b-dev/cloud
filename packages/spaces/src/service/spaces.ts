import { type PageParams, type Paginated, paginate } from "@k2b/stdlib";
import { type AccessSubject, hasPermission, type PermissionLevel } from "@k2b/cloud/server";
import { logger, serviceAccounts } from "@k2b/cloud/services";
import { sql } from "bun";
import type { CreateSpace, MutationResult, Space, SpaceDetail, UpdateSpace } from "@/contracts";
import { newShortId, withShortIdRetry } from "../lib/short-id";
import {
  buildSpacePrincipalCondition,
  getSpacePermission,
  grantSpaceAccess,
  isSpaceResourceId,
  SPACE_RESOURCE_TYPE,
  SPACES_APP_ID,
} from "./access";
import type { SpaceActivityIdentity } from "./activity";
import * as activity from "./activity";
import { publishSpaceEvent } from "./events";
import { spacesMessages } from "./messages";
import { rank } from "./rank";

// ==========================
// Spaces Service
// ==========================

const log = logger("spaces:spaces");

type DbSpace = {
  id: string;
  name: string;
  description: string | null;
  color: string;
  ical_token: string | null;
  created_at: Date;
  updated_at: Date;
};

type DbSpaceWithPermission = DbSpace & {
  permission_rank: number;
};

export type SpaceWithPermission = Space & {
  permission: Exclude<PermissionLevel, "none">;
};

type DbSpaceAdmin = DbSpace & {
  permission_count: number;
};

export type SpaceAdminListItem = Space & {
  permissionCount: number;
};

type DbColumn = {
  id: string;
  space_id: string;
  name: string;
  color: string | null;
  rank: string;
  is_done: boolean;
};

type DbTag = {
  id: string;
  space_id: string;
  name: string;
  color: string;
};

/**
 * Converts one `spaces.spaces` row into the API-facing `Space` model.
 */
const mapToSpace = (row: DbSpace): Space => ({
  id: row.id,
  name: row.name,
  description: row.description,
  color: row.color,
  icalToken: row.ical_token,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const mapToSpaceWithPermission = (row: DbSpaceWithPermission): SpaceWithPermission => ({
  ...mapToSpace(row),
  permission: row.permission_rank >= 3 ? "admin" : row.permission_rank === 2 ? "write" : "read",
});

const mapToSpaceAdminItem = (row: DbSpaceAdmin): SpaceAdminListItem => ({
  ...mapToSpace(row),
  permissionCount: row.permission_count,
});

const starterColumns = (starter: NonNullable<CreateSpace["starter"]>, locale?: string | null) => {
  const t = spacesMessages(locale);
  const defaults = [
    { name: t.starterToDo, color: "#6b7280", isDone: false },
    { name: t.starterInProgress, color: "#3b82f6", isDone: false },
    { name: t.starterDone, color: "#22c55e", isDone: true },
  ];
  if (starter === "blank") return [defaults[0]!, defaults[2]!];
  if (starter === "tasks") return defaults;
  if (starter === "calendar") {
    return [
      { name: t.starterIdeas, color: "#8b5cf6", isDone: false },
      { name: t.starterScheduled, color: "#3b82f6", isDone: false },
      defaults[2]!,
    ];
  }
  return [
    { name: t.starterBacklog, color: "#6b7280", isDone: false },
    defaults[1]!,
    { name: t.starterReview, color: "#f59e0b", isDone: false },
    defaults[2]!,
  ];
};

/**
 * Check if an actor has access to a space.
 */
export const canAccess = async (params: { spaceId: string; subject: AccessSubject; requiredLevel?: PermissionLevel }): Promise<boolean> => {
  const { spaceId, requiredLevel = "read" } = params;

  const permission = await getSpacePermission({
    spaceId,
    subject: params.subject,
  });

  if (permission !== "none") {
    return hasPermission(permission, requiredLevel);
  }

  return false;
};

/**
 * Get the effective permission level for an actor on a space.
 */
export const getPermission = async (params: { spaceId: string; subject: AccessSubject }): Promise<PermissionLevel> => {
  const permission = await getSpacePermission(params);

  if (permission !== "none") {
    return permission;
  }

  return "none";
};

/**
 * List all spaces accessible to an actor via the permission system.
 */
export const list = async (params: {
  subject: AccessSubject;
  boundSpaceId?: string | null;
  requiredLevel?: PermissionLevel;
}): Promise<Space[]> => {
  if (params.subject.type === "service_account" && !isSpaceResourceId(params.boundSpaceId)) return [];
  const principalMatch = buildSpacePrincipalCondition(params.subject);
  const bindingMatch = params.subject.type === "service_account" ? sql`s.id = ${params.boundSpaceId}::uuid` : sql`true`;
  const permissionMatch =
    params.requiredLevel === "admin"
      ? sql`a.permission = 'admin'::auth.permission_level`
      : params.requiredLevel === "write"
        ? sql`a.permission IN ('write'::auth.permission_level, 'admin'::auth.permission_level)`
        : sql`a.permission <> 'none'::auth.permission_level`;

  const rows = await sql<DbSpace[]>`
    SELECT DISTINCT s.id, s.name, s.description, s.color, s.ical_token, s.created_at, s.updated_at
    FROM spaces.spaces s
    LEFT JOIN spaces.space_access sa ON s.id = sa.space_id
    LEFT JOIN auth.access a ON sa.access_id = a.id
    WHERE ${permissionMatch}
      AND ${principalMatch}
      AND ${bindingMatch}
    ORDER BY s.name
  `;
  return rows.map(mapToSpace);
};

/** List an actor's accessible Spaces with effective permission and SQL-side filtering/pagination. */
export const listPage = async (params: {
  subject: AccessSubject;
  boundSpaceId?: string | null;
  requiredLevel?: PermissionLevel;
  query?: string;
  pagination?: PageParams;
}): Promise<Paginated<SpaceWithPermission>> => {
  const { page, perPage, offset } = paginate(params.pagination);
  if (params.subject.type === "service_account" && !isSpaceResourceId(params.boundSpaceId)) {
    return { items: [], page, perPage, total: 0, hasNext: false };
  }

  const principalMatch = buildSpacePrincipalCondition(params.subject);
  const bindingMatch = params.subject.type === "service_account" ? sql`s.id = ${params.boundSpaceId}::uuid` : sql`true`;
  const permissionMatch =
    params.requiredLevel === "admin"
      ? sql`a.permission = 'admin'::auth.permission_level`
      : params.requiredLevel === "write"
        ? sql`a.permission IN ('write'::auth.permission_level, 'admin'::auth.permission_level)`
        : sql`a.permission <> 'none'::auth.permission_level`;
  const query = params.query?.trim();
  const pattern = query ? `%${query}%` : null;

  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(DISTINCT s.id)::int AS count
    FROM spaces.spaces s
    JOIN spaces.space_access sa ON s.id = sa.space_id
    JOIN auth.access a ON sa.access_id = a.id
    WHERE ${permissionMatch}
      AND ${principalMatch}
      AND ${bindingMatch}
      AND (${pattern}::text IS NULL OR s.name ILIKE ${pattern} OR s.description ILIKE ${pattern})
  `;
  const rows = await sql<DbSpaceWithPermission[]>`
    SELECT
      s.id,
      s.name,
      s.description,
      s.color,
      s.ical_token,
      s.created_at,
      s.updated_at,
      MAX(CASE a.permission
        WHEN 'admin'::auth.permission_level THEN 3
        WHEN 'write'::auth.permission_level THEN 2
        ELSE 1
      END)::int AS permission_rank
    FROM spaces.spaces s
    JOIN spaces.space_access sa ON s.id = sa.space_id
    JOIN auth.access a ON sa.access_id = a.id
    WHERE ${permissionMatch}
      AND ${principalMatch}
      AND ${bindingMatch}
      AND (${pattern}::text IS NULL OR s.name ILIKE ${pattern} OR s.description ILIKE ${pattern})
    GROUP BY s.id, s.name, s.description, s.color, s.ical_token, s.created_at, s.updated_at
    ORDER BY lower(s.name), s.id
    LIMIT ${perPage}
    OFFSET ${offset}
  `;
  const total = countRow?.count ?? 0;
  return {
    items: rows.map(mapToSpaceWithPermission),
    page,
    perPage,
    total,
    hasNext: page * perPage < total,
  };
};

/**
 * List all spaces for admin pages with a permission-entry count.
 */
export const listAdmin = async (params: {
  search?: string;
  pagination: { limit: number; offset: number };
}): Promise<{ items: SpaceAdminListItem[]; total: number }> => {
  const query = params.search?.trim().toLowerCase();
  const pattern = query && query.length > 0 ? `%${query}%` : null;

  const rows = await sql<DbSpaceAdmin[]>`
    SELECT
      s.id,
      s.name,
      s.description,
      s.color,
      s.ical_token,
      s.created_at,
      s.updated_at,
      COUNT(sa.access_id)::int AS permission_count
    FROM spaces.spaces s
    LEFT JOIN spaces.space_access sa ON sa.space_id = s.id
    WHERE (
      ${pattern}::text IS NULL
      OR LOWER(s.name) LIKE ${pattern}
    )
    GROUP BY s.id, s.name, s.description, s.color, s.ical_token, s.created_at, s.updated_at
    ORDER BY LOWER(s.name) ASC, s.created_at ASC
    LIMIT ${params.pagination.limit}
    OFFSET ${params.pagination.offset}
  `;

  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM spaces.spaces s
    WHERE (
      ${pattern}::text IS NULL
      OR LOWER(s.name) LIKE ${pattern}
    )
  `;

  return {
    items: rows.map(mapToSpaceAdminItem),
    total: countRow?.count ?? 0,
  };
};

/**
 * Aggregated admin stats — single SQL roundtrip. Filtered by `search` so the
 * numbers match what the admin sees in the table. Counted in the DB, NOT in
 * the page-bound items array (which only sees the visible page).
 */
export const adminSummary = async (params: {
  search?: string;
}): Promise<{
  total: number;
  orphaned: number;
  totalPermissions: number;
}> => {
  const query = params.search?.trim().toLowerCase();
  const pattern = query && query.length > 0 ? `%${query}%` : null;

  const [row] = await sql<{ total: number; orphaned: number; total_permissions: number }[]>`
    WITH filtered AS (
      SELECT s.id, COUNT(sa.access_id)::int AS permission_count
      FROM spaces.spaces s
      LEFT JOIN spaces.space_access sa ON sa.space_id = s.id
      WHERE (${pattern}::text IS NULL OR LOWER(s.name) LIKE ${pattern})
      GROUP BY s.id
    )
    SELECT
      COUNT(*)::int                                             AS total,
      COUNT(*) FILTER (WHERE permission_count = 0)::int         AS orphaned,
      COALESCE(SUM(permission_count), 0)::int                   AS total_permissions
    FROM filtered
  `;
  return {
    total: row?.total ?? 0,
    orphaned: row?.orphaned ?? 0,
    totalPermissions: row?.total_permissions ?? 0,
  };
};

/**
 * Get a space by ID
 */
export const get = async (params: { id: string }): Promise<Space | null> => {
  const [row] = await sql<DbSpace[]>`
    SELECT id, name, description, color, ical_token, created_at, updated_at
    FROM spaces.spaces
    WHERE id = ${params.id}
  `;
  return row ? mapToSpace(row) : null;
};

/**
 * Get a space with its columns and tags
 */
export const getDetail = async (params: { id: string }): Promise<SpaceDetail | null> => {
  const [spaceRow] = await sql<DbSpace[]>`
    SELECT id, name, description, color, ical_token, created_at, updated_at
    FROM spaces.spaces
    WHERE id = ${params.id}
  `;

  if (!spaceRow) return null;

  const columns = await sql<DbColumn[]>`
    SELECT id, space_id, name, color, rank::text AS rank, is_done
    FROM spaces.columns
    WHERE space_id = ${params.id}
    ORDER BY rank
  `;

  const tags = await sql<DbTag[]>`
    SELECT id, space_id, name, color
    FROM spaces.tags
    WHERE space_id = ${params.id}
    ORDER BY name
  `;

  return {
    ...mapToSpace(spaceRow),
    columns: columns.map((c) => ({
      id: c.id,
      spaceId: c.space_id,
      name: c.name,
      color: c.color,
      rank: c.rank,
      isDone: c.is_done,
    })),
    tags: tags.map((t) => ({
      id: t.id,
      spaceId: t.space_id,
      name: t.name,
      color: t.color,
    })),
  };
};

/**
 * Create a new space with default columns.
 * Automatically grants admin access to the creator.
 */
export const create = async (params: {
  data: CreateSpace;
  creatorId: string;
  actor?: SpaceActivityIdentity;
  locale?: string | null;
}): Promise<MutationResult<Space>> => {
  const { data, creatorId } = params;
  const columns = starterColumns(data.starter ?? "blank", params.locale);

  const row = await withShortIdRetry(["space", "column"], () =>
    sql.begin(async (tx): Promise<DbSpace | null> => {
      const [created] = await tx<DbSpace[]>`
      INSERT INTO spaces.spaces (short_id, name, description, color)
      VALUES (${newShortId()}, ${data.name}, ${data.description ?? null}, ${data.color})
      RETURNING id, name, description, color, ical_token, created_at, updated_at
    `;

      if (!created) return null;

      for (const [index, col] of columns.entries()) {
        await tx`
      INSERT INTO spaces.columns (short_id, space_id, name, color, rank, is_done)
      VALUES (${newShortId()}, ${created.id}, ${col.name}, ${col.color}, ${rank.toDb(rank.atIndex(index))}::bigint, ${col.isDone})
    `;
      }

      return created;
    }),
  );

  if (!row) {
    return { ok: false, error: "Failed to create space", status: 500 };
  }

  const access = await grantSpaceAccess({
    spaceId: row.id,
    principal: { type: "user", userId: creatorId },
    permission: "admin",
  });
  if (!access.ok) {
    await sql`
      DELETE FROM spaces.spaces
      WHERE id = ${row.id}::uuid
    `;
    return { ok: false, error: access.error.message, status: access.error.status };
  }

  const space = mapToSpace(row);
  try {
    await activity.record({
      spaceId: space.id,
      actor: params.actor ?? { kind: "user", id: creatorId },
      action: "space.created",
    });
  } catch (error) {
    log.warn("Failed to record activity for created space", { spaceId: space.id, error });
  }
  return { ok: true, data: space };
};

/**
 * Update a space
 */
export const update = async (params: { id: string; data: UpdateSpace; actor?: SpaceActivityIdentity }): Promise<MutationResult<Space>> => {
  const { id, data } = params;

  const existing = await get({ id });
  if (!existing) {
    return { ok: false, error: "Space not found", status: 404 };
  }

  const name = data.name ?? existing.name;
  const description = data.description === undefined ? existing.description : data.description;
  const color = data.color ?? existing.color;

  const row = await sql.begin(async (tx) => {
    const [updated] = await tx<DbSpace[]>`
      UPDATE spaces.spaces
      SET name = ${name}, description = ${description}, color = ${color}, updated_at = now()
      WHERE id = ${id}
      RETURNING id, name, description, color, ical_token, created_at, updated_at
    `;
    if (!updated) return null;
    await activity.record(
      {
        spaceId: id,
        actor: params.actor ?? { kind: "system", id: null },
        action: "space.updated",
        bucketStartedAt: new Date(new Date().setUTCMinutes(0, 0, 0)),
      },
      tx,
    );
    return updated;
  });

  if (!row) {
    return { ok: false, error: "Failed to update space", status: 500 };
  }

  await publishSpaceEvent({ type: "space.updated", spaceId: id });
  return { ok: true, data: mapToSpace(row) };
};

/**
 * Delete a space
 */
export const remove = async (params: { id: string }): Promise<MutationResult<void>> => {
  const rows = await sql<{ short_id: string }[]>`
    DELETE FROM spaces.spaces
    WHERE id = ${params.id}
    RETURNING short_id
  `;

  const deleted = rows[0];
  if (!deleted) {
    return { ok: false, error: "Space not found", status: 404 };
  }

  await serviceAccounts.deleteForResource({
    appId: SPACES_APP_ID,
    resourceType: SPACE_RESOURCE_TYPE,
    resourceId: params.id,
  });

  await publishSpaceEvent({ type: "space.deleted", spaceId: params.id }, { spaceId: deleted.short_id });

  return { ok: true, data: undefined };
};

/**
 * Regenerate the iCal token for a space
 */
export const regenerateICalToken = async (params: { id: string }): Promise<MutationResult<{ icalToken: string }>> => {
  const [row] = await sql<{ ical_token: string }[]>`
    UPDATE spaces.spaces
    SET ical_token = encode(gen_random_bytes(24), 'hex'), updated_at = now()
    WHERE id = ${params.id}
    RETURNING ical_token
  `;

  if (!row) {
    return { ok: false, error: "Space not found", status: 404 };
  }

  return { ok: true, data: { icalToken: row.ical_token } };
};

/**
 * Get a space by its iCal token (for public iCal feed)
 */
export const getByICalToken = async (params: { token: string }): Promise<Space | null> => {
  const [row] = await sql<DbSpace[]>`
    SELECT id, name, description, color, ical_token, created_at, updated_at
    FROM spaces.spaces
    WHERE ical_token = ${params.token}
  `;
  return row ? mapToSpace(row) : null;
};
