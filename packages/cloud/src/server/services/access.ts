import { err, fail, ok, type Result } from "@k2b/stdlib";
import { type SQLQuery, sql } from "bun";
import { recursiveGroupIdsSubquery } from "../../services/accounts/group-sql";
import { toPgUuidArray } from "../../services/postgres";

export type AccessDb = typeof sql;

// ==========================
// Permission Levels
// ==========================

export const PERMISSION_LEVELS = ["none", "read", "write", "admin"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

/** Compare permission levels (returns true if a >= b) */
export const hasPermission = (userLevel: PermissionLevel, requiredLevel: PermissionLevel): boolean => {
  const levels = PERMISSION_LEVELS;
  return levels.indexOf(userLevel) >= levels.indexOf(requiredLevel);
};

// ==========================
// Principal Types
// ==========================

export type PrincipalType = "user" | "group" | "service_account" | "authenticated" | "public";

export type Principal =
  | { type: "user"; userId: string }
  | { type: "group"; groupId: string }
  | { type: "service_account"; serviceAccountId: string }
  | { type: "authenticated" }
  | { type: "public" };

export type AccessSubject =
  | { type: "user"; userId: string; delegatedByServiceAccountId?: string | null }
  | { type: "service_account"; serviceAccountId: string };

export type EffectiveGroup = {
  id: string;
  name: string;
};

export type AccessPrincipalColumns = {
  userId: SQLQuery;
  groupId: SQLQuery;
  serviceAccountId: SQLQuery;
  authenticatedOnly: SQLQuery;
};

export type AccessPrincipalTierConditions = {
  serviceAccount: SQLQuery;
  user: SQLQuery;
  group: SQLQuery;
  authenticated: SQLQuery;
  public: SQLQuery;
};

// ==========================
// Access Entry Types
// ==========================

export type AccessEntry = {
  id: string;
  principal: Principal;
  permission: PermissionLevel;
  createdAt: string;
  // Resolved display info (populated by service)
  displayName?: string;
  avatarHash?: string | null;
};

export type AccessUserSource =
  | { type: "direct" }
  | {
      type: "group";
      /** Top-level group from the access grant, not the nested membership group. */
      groupId: string;
      groupName: string;
    };

export type AccessUser = {
  id: string;
  uid: string;
  displayName: string;
  avatarHash: string | null;
  permission: Exclude<PermissionLevel, "none">;
  source: AccessUserSource;
};

type DbAccess = {
  id: string;
  user_id: string | null;
  group_id: string | null;
  service_account_id: string | null;
  authenticated_only: boolean;
  permission: PermissionLevel;
  created_at: Date;
};

type DbAccessUser = {
  id: string;
  uid: string;
  display_name: string;
  avatar_hash: string | null;
  permission: Exclude<PermissionLevel, "none">;
  direct: boolean;
  source_group_id: string | null;
  source_group_name: string | null;
};

// ==========================
// Helper Functions
// ==========================

const uniqueIds = (values: string[] | null | undefined): string[] => [...new Set((values ?? []).filter(Boolean))];

const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, (match) => `\\${match}`);

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  none: 1,
  read: 2,
  write: 3,
  admin: 4,
};

/**
 * Builds a typed access principal from one database access row.
 */
const principalFromDb = (row: DbAccess): Principal => {
  if (row.user_id) return { type: "user", userId: row.user_id };
  if (row.group_id) return { type: "group", groupId: row.group_id };
  if (row.service_account_id) return { type: "service_account", serviceAccountId: row.service_account_id };
  if (row.authenticated_only) return { type: "authenticated" };
  return { type: "public" };
};

/**
 * Maps raw access rows into the normalized AccessEntry shape used by app services.
 */
const mapToAccessEntry = (row: DbAccess): AccessEntry => ({
  id: row.id,
  principal: principalFromDb(row),
  permission: row.permission,
  createdAt: row.created_at.toISOString(),
});

// ==========================
// Core Access Service
// ==========================

/**
 * Create a new access entry.
 * Returns the created entry ID.
 */
export const createAccess = async (
  params: { principal: Principal; permission: PermissionLevel },
  db: AccessDb = sql,
): Promise<Result<{ id: string }>> => {
  const { principal, permission } = params;

  let userId: string | null = null;
  let groupId: string | null = null;
  let serviceAccountId: string | null = null;
  let authenticatedOnly = false;

  if (principal.type === "user") {
    userId = principal.userId;
    // Verify user exists
    const [user] = await db<{ id: string }[]>`
      SELECT id FROM auth.users WHERE id = ${userId}::uuid
    `;
    if (!user) {
      return fail(err.notFound("User"));
    }
  } else if (principal.type === "group") {
    groupId = principal.groupId;
    // Verify group exists
    const [group] = await db<{ id: string }[]>`
      SELECT id FROM auth.groups WHERE id = ${groupId}::uuid
    `;
    if (!group) {
      return fail(err.notFound("Group"));
    }
  } else if (principal.type === "service_account") {
    serviceAccountId = principal.serviceAccountId;
    const [serviceAccount] = await db<{ id: string }[]>`
      SELECT id FROM auth.service_accounts WHERE id = ${serviceAccountId}::uuid AND status = 'active'
    `;
    if (!serviceAccount) {
      return fail(err.notFound("Service account"));
    }
  } else if (principal.type === "authenticated") {
    authenticatedOnly = true;
  }
  // public: user/group null, authenticated_only false

  const [row] = await db<{ id: string }[]>`
    INSERT INTO auth.access (user_id, group_id, service_account_id, authenticated_only, permission)
    VALUES (${userId}::uuid, ${groupId}::uuid, ${serviceAccountId}::uuid, ${authenticatedOnly}, ${permission}::auth.permission_level)
    RETURNING id
  `;

  if (!row) {
    return fail(err.internal("Failed to create access entry"));
  }

  return ok({ id: row.id });
};

/**
 * Get an access entry by ID.
 */
export const getAccess = async (params: { id: string }, db: AccessDb = sql): Promise<AccessEntry | null> => {
  const [row] = await db<DbAccess[]>`
    SELECT id, user_id, group_id, service_account_id, authenticated_only, permission, created_at
    FROM auth.access
    WHERE id = ${params.id}::uuid
  `;
  return row ? mapToAccessEntry(row) : null;
};

/**
 * Update an access entry's permission level.
 */
export const updateAccess = async (params: { id: string; permission: PermissionLevel }, db: AccessDb = sql): Promise<Result<void>> => {
  const result = await db`
    UPDATE auth.access
    SET permission = ${params.permission}::auth.permission_level
    WHERE id = ${params.id}::uuid
  `;

  if (result.count === 0) {
    return fail(err.notFound("Access entry"));
  }

  return ok();
};

/** Resolve direct and nested group memberships from the authoritative database mirror. */
export const getEffectiveGroups = async (params: { userId: string | null }, db: AccessDb = sql): Promise<EffectiveGroup[]> => {
  if (!params.userId) return [];
  const rows = await db<{ id: string; name: string }[]>`
    SELECT g.id, g.name
    FROM auth.groups g
    WHERE g.id IN (${recursiveGroupIdsSubquery(params.userId)})
    ORDER BY g.name
  `;
  return rows;
};

export const getEffectiveGroupIds = async (params: { userId: string | null }, db: AccessDb = sql): Promise<string[]> =>
  (await getEffectiveGroups(params, db)).map((group) => group.id);

/**
 * Delete an access entry.
 */
export const deleteAccess = async (params: { id: string }, db: AccessDb = sql): Promise<Result<void>> => {
  const result = await db`
    DELETE FROM auth.access
    WHERE id = ${params.id}::uuid
  `;

  if (result.count === 0) {
    return fail(err.notFound("Access entry"));
  }

  return ok();
};

// ==========================
// Resource Access Helpers
// ==========================

/**
 * Generic interface for resource access junction tables.
 * Each app implements this to connect their resources to auth.access.
 */
export type ResourceAccessAdapter<TResourceId = string> = {
  /** Get all access entries for a resource */
  list: (resourceId: TResourceId) => Promise<AccessEntry[]>;
  /** Add an access entry to a resource */
  add: (resourceId: TResourceId, accessId: string) => Promise<Result<void>>;
  /** Remove an access entry from a resource */
  remove: (resourceId: TResourceId, accessId: string) => Promise<Result<void>>;
  /** Count access entries for a resource */
  count: (resourceId: TResourceId) => Promise<number>;
};

/**
 * Build canonical principal predicates for one auth.access row, separated by
 * precedence tier.
 *
 * Apps provide column fragments because access rows are commonly joined under
 * different aliases. The subject is authoritative: group membership is always
 * resolved recursively from its user id and never accepted from a caller.
 * Resource binding, credential scopes, and permission precedence remain the
 * responsibility of the app using the predicate.
 */
export const buildAccessPrincipalTierConditions = (params: {
  subject: AccessSubject | null;
  columns: AccessPrincipalColumns;
}): AccessPrincipalTierConditions => {
  const userId = params.subject?.type === "user" ? params.subject.userId : null;
  const serviceAccountId = params.subject?.type === "service_account" ? params.subject.serviceAccountId : null;
  const authenticated = params.subject !== null;
  const columns = params.columns;

  return {
    serviceAccount: sql`${columns.serviceAccountId} = ${serviceAccountId}::uuid`,
    user: sql`${columns.userId} = ${userId}::uuid`,
    group: sql`(
      ${userId}::uuid IS NOT NULL
      AND ${columns.groupId} IN (${userId ? recursiveGroupIdsSubquery(userId) : sql`SELECT NULL::uuid WHERE FALSE`})
    )`,
    authenticated: sql`${authenticated} AND ${columns.authenticatedOnly} = true`,
    public: sql`(
      ${columns.userId} IS NULL
      AND ${columns.groupId} IS NULL
      AND ${columns.serviceAccountId} IS NULL
      AND ${columns.authenticatedOnly} = false
    )`,
  };
};

/** Build one predicate that matches every principal tier for the subject. */
export const buildAccessPrincipalCondition = (params: { subject: AccessSubject | null; columns: AccessPrincipalColumns }): SQLQuery => {
  const tiers = buildAccessPrincipalTierConditions(params);
  return sql`(${tiers.serviceAccount} OR ${tiers.user} OR ${tiers.group} OR ${tiers.authenticated} OR ${tiers.public})`;
};

/**
 * Get the effective permission level for an actor on a resource.
 * Returns the highest permission from:
 * - Direct user or service-account access
 * - Direct and nested user group memberships resolved from the database
 * - Authenticated access for every authenticated subject
 * - Public access for every subject, including anonymous callers
 */
export const getEffectivePermission = async (params: {
  accessIds: string[];
  subject?: AccessSubject | null;
  /** @deprecated Pass subject instead. */
  userId?: string | null;
  /** @deprecated Membership is resolved from userId and this value is intentionally ignored. */
  userGroups?: string[];
  /** @deprecated Pass subject instead. */
  serviceAccountId?: string | null;
}): Promise<PermissionLevel> => {
  const accessIds = params.accessIds ?? [];
  const subject =
    "subject" in params
      ? (params.subject ?? null)
      : params.userId
        ? { type: "user" as const, userId: params.userId }
        : params.serviceAccountId
          ? { type: "service_account" as const, serviceAccountId: params.serviceAccountId }
          : null;
  const legacyServiceAccountId = !("subject" in params) && !params.userId ? (params.serviceAccountId ?? null) : null;

  if (accessIds.length === 0) return "none";

  // Legacy callers did not provide resource binding or scope context. Keep
  // their service-account lookup direct-only so the new authenticated/public
  // semantics require an explicit AccessSubject migration.
  const principalMatch = legacyServiceAccountId
    ? sql`a.service_account_id = ${legacyServiceAccountId}::uuid`
    : buildAccessPrincipalCondition({
        subject,
        columns: {
          userId: sql`a.user_id`,
          groupId: sql`a.group_id`,
          serviceAccountId: sql`a.service_account_id`,
          authenticatedOnly: sql`a.authenticated_only`,
        },
      });

  const rows = await sql<{ permission: PermissionLevel }[]>`
    SELECT a.permission
    FROM auth.access a
    WHERE a.id = ANY(${toPgUuidArray(accessIds)}::uuid[])
      AND ${principalMatch}
    ORDER BY
      CASE permission
        WHEN 'admin' THEN 4
        WHEN 'write' THEN 3
        WHEN 'read' THEN 2
        WHEN 'none' THEN 1
      END DESC
    LIMIT 1
  `;

  return rows[0]?.permission ?? "none";
};

/**
 * Lists concrete users reachable from auth.access entries.
 *
 * Apps stay responsible for collecting the relevant access entry IDs from their
 * own junction tables. This helper expands direct user grants and recursive
 * group grants only. It intentionally does not expand public or
 * authenticated-only grants into "all users", because those scopes are not
 * bounded, predictable assignee/member lists.
 */
export const listUsersWithAccess = async (params: {
  accessIds: string[];
  search?: string;
  userIds?: string[];
  excludeUserIds?: string[];
  minimumPermission?: Exclude<PermissionLevel, "none">;
  limit?: number;
  db?: AccessDb;
}): Promise<AccessUser[]> => {
  const accessIds = uniqueIds(params.accessIds);
  if (accessIds.length === 0) return [];

  const requestedUserIds = uniqueIds(params.userIds);
  const excludeUserIds = uniqueIds(params.excludeUserIds);
  const query = params.search?.trim().toLowerCase();
  const pattern = query ? `%${escapeLikePattern(query)}%` : null;
  const minimumRank = PERMISSION_RANK[params.minimumPermission ?? "read"];
  const defaultLimit = requestedUserIds.length > 0 ? requestedUserIds.length : 20;
  const limit = Math.min(Math.max(params.limit ?? defaultLimit, 1), 500);
  const db = params.db ?? sql;
  const userFilter = requestedUserIds.length > 0 ? db`AND id = ANY(${toPgUuidArray(requestedUserIds)}::uuid[])` : db``;

  const rows = await db<DbAccessUser[]>`
    WITH RECURSIVE
      root_groups(root_group_id, root_group_name, group_id, group_ids, permission, permission_rank) AS (
        SELECT
          a.group_id,
          COALESCE(NULLIF(g.name, ''), g.cn),
          a.group_id,
          ARRAY[a.group_id]::uuid[],
          a.permission,
          CASE a.permission
            WHEN 'admin' THEN 4
            WHEN 'write' THEN 3
            WHEN 'read' THEN 2
            ELSE 1
          END
        FROM auth.access a
        JOIN auth.groups g ON g.id = a.group_id
        WHERE a.id = ANY(${toPgUuidArray(accessIds)}::uuid[])
          AND a.group_id IS NOT NULL
          AND CASE a.permission
            WHEN 'admin' THEN 4
            WHEN 'write' THEN 3
            WHEN 'read' THEN 2
            ELSE 1
          END >= ${minimumRank}

        UNION ALL

        SELECT
          rg.root_group_id,
          rg.root_group_name,
          gg.child_group_id,
          rg.group_ids || gg.child_group_id,
          rg.permission,
          rg.permission_rank
        FROM auth.group_groups_v2 gg
        JOIN root_groups rg ON rg.group_id = gg.parent_group_id
        WHERE NOT gg.child_group_id = ANY(rg.group_ids)
      ),
      candidate_users AS (
        SELECT
          u.id,
          u.uid,
          COALESCE(NULLIF(u.display_name, ''), u.uid, u.id::text) AS display_name,
          u.avatar_hash,
          TRUE AS direct,
          NULL::uuid AS source_group_id,
          NULL::text AS source_group_name,
          a.permission,
          CASE a.permission
            WHEN 'admin' THEN 4
            WHEN 'write' THEN 3
            WHEN 'read' THEN 2
            ELSE 1
          END AS permission_rank
        FROM auth.access a
        JOIN auth.users u ON u.id = a.user_id
        WHERE a.id = ANY(${toPgUuidArray(accessIds)}::uuid[])
          AND a.user_id IS NOT NULL
          AND CASE a.permission
            WHEN 'admin' THEN 4
            WHEN 'write' THEN 3
            WHEN 'read' THEN 2
            ELSE 1
          END >= ${minimumRank}

        UNION ALL

        SELECT
          u.id,
          u.uid,
          COALESCE(NULLIF(u.display_name, ''), u.uid, u.id::text) AS display_name,
          u.avatar_hash,
          FALSE AS direct,
          rg.root_group_id AS source_group_id,
          rg.root_group_name AS source_group_name,
          rg.permission,
          rg.permission_rank
        FROM root_groups rg
        JOIN auth.user_groups_v2 ug ON ug.group_id = rg.group_id
        JOIN auth.users u ON u.id = ug.user_id
      ),
      access_users AS (
        SELECT
          id,
          uid,
          display_name,
          avatar_hash,
          CASE MAX(permission_rank)
            WHEN 4 THEN 'admin'
            WHEN 3 THEN 'write'
            ELSE 'read'
          END AS permission,
          BOOL_OR(direct) AS direct,
          (
            ARRAY_AGG(source_group_id ORDER BY permission_rank DESC, source_group_name)
            FILTER (WHERE NOT direct AND source_group_id IS NOT NULL)
          )[1] AS source_group_id,
          (
            ARRAY_AGG(source_group_name ORDER BY permission_rank DESC, source_group_name)
            FILTER (WHERE NOT direct AND source_group_name IS NOT NULL)
          )[1] AS source_group_name,
          COALESCE(
            STRING_AGG(source_group_name, ' ')
            FILTER (WHERE NOT direct AND source_group_name IS NOT NULL),
            ''
          ) AS group_names
        FROM candidate_users
        GROUP BY id, uid, display_name, avatar_hash
      )
    SELECT id, uid, display_name, avatar_hash, permission, direct, source_group_id, source_group_name
    FROM access_users
    WHERE id <> ALL(${toPgUuidArray(excludeUserIds)}::uuid[])
      AND (direct OR (source_group_id IS NOT NULL AND source_group_name IS NOT NULL))
      ${userFilter}
      AND (
        ${pattern}::text IS NULL
        OR LOWER(display_name) LIKE ${pattern} ESCAPE '\\'
        OR LOWER(uid) LIKE ${pattern} ESCAPE '\\'
        OR LOWER(group_names) LIKE ${pattern} ESCAPE '\\'
      )
    ORDER BY LOWER(display_name), id
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    id: row.id,
    uid: row.uid,
    displayName: row.display_name,
    avatarHash: row.avatar_hash,
    permission: row.permission,
    source: row.direct
      ? { type: "direct" }
      : {
          type: "group",
          groupId: row.source_group_id as string,
          groupName: row.source_group_name as string,
        },
  }));
};

/**
 * Resolve display names for access entries.
 * Populates the displayName field based on principal type.
 */
export const resolveDisplayNames = async <T extends { principal: Principal }>(
  entries: T[],
): Promise<(T & { displayName: string; avatarHash?: string | null })[]> => {
  const userIds = entries.filter((e) => e.principal.type === "user").map((e) => (e.principal as { type: "user"; userId: string }).userId);

  const groupIds = entries
    .filter((e) => e.principal.type === "group")
    .map((e) => (e.principal as { type: "group"; groupId: string }).groupId);

  const serviceAccountIds = entries
    .filter((e) => e.principal.type === "service_account")
    .map((e) => (e.principal as { type: "service_account"; serviceAccountId: string }).serviceAccountId);

  // Fetch user display names
  const userNames = new Map<string, { displayName: string; avatarHash: string | null }>();
  if (userIds.length > 0) {
    const users = await sql<{ id: string; display_name: string; uid: string; avatar_hash: string | null }[]>`
      SELECT id, display_name, uid, avatar_hash
      FROM auth.users
      WHERE id = ANY(${toPgUuidArray(userIds)}::uuid[])
    `;
    for (const u of users) {
      userNames.set(u.id, { displayName: u.display_name || u.uid, avatarHash: u.avatar_hash });
    }
  }

  const groupNames = new Map<string, string>();
  if (groupIds.length > 0) {
    const groups = await sql<{ id: string; name: string }[]>`
      SELECT id, name
      FROM auth.groups
      WHERE id = ANY(${toPgUuidArray(groupIds)}::uuid[])
    `;
    for (const group of groups) {
      groupNames.set(group.id, group.name);
    }
  }

  const serviceAccountNames = new Map<string, string>();
  if (serviceAccountIds.length > 0) {
    const serviceAccounts = await sql<{ id: string; name: string }[]>`
      SELECT id, name
      FROM auth.service_accounts
      WHERE id = ANY(${toPgUuidArray(serviceAccountIds)}::uuid[])
    `;
    for (const serviceAccount of serviceAccounts) {
      serviceAccountNames.set(serviceAccount.id, serviceAccount.name);
    }
  }

  return entries.map((entry) => {
    let displayName: string;
    let avatarHash: string | null | undefined;
    switch (entry.principal.type) {
      case "user": {
        const user = userNames.get(entry.principal.userId);
        displayName = user?.displayName ?? "Unknown User";
        avatarHash = user?.avatarHash ?? null;
        break;
      }
      case "group":
        displayName = groupNames.get(entry.principal.groupId) ?? "Unknown Group";
        break;
      case "service_account":
        displayName = serviceAccountNames.get(entry.principal.serviceAccountId) ?? "Unknown Service Account";
        break;
      case "authenticated":
        displayName = "All users (incl. guests)";
        break;
      case "public":
        displayName = "Public";
        break;
    }
    return { ...entry, displayName, avatarHash };
  });
};
