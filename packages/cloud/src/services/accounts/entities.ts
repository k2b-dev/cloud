import { sql } from "bun";
import type { EntityKind, EntityListItem, UserProfile, UserProvider } from "../../contracts/shared";
import { getFreeIpaConfig } from "../freeipa-config";
import { escapeLikePattern, toPgTextArray, toPgUuidArray } from "../postgres";
import { buildBaseGroup, personalOwnerJoin } from "./base-group";
import { buildBaseUser } from "./base-user";
import { buildManagedGroupScopeCondition, recursiveGroupIdsSubquery } from "./group-sql";

type DbRow = Record<string, unknown>;
type SqlFragment = any;

export type EntityListParams = {
  visibility: { type: "directory" } | { type: "self_and_effective_groups"; userId: string };
  search?: string;
  kinds?: EntityKind[];
  provider?: UserProvider;
  profile?: UserProfile;
  userIds?: string[];
  groupIds?: string[];
  excludeUserIds?: string[];
  excludeGroupIds?: string[];
  excludeServiceAccountIds?: string[];
  userMemberOfGroupIds?: string[];
  memberOfGroupId?: string;
  managerOfGroupId?: string;
  parentGroupId?: string;
  managedByUserId?: string;
  recursive?: boolean;
  /**
   * Personal Linux groups are left out of directory browsing and search by
   * default. Exact `groupIds` lookups and relation filters always return them.
   */
  includePersonal?: boolean;
  page?: number;
  perPage?: number;
};

type EntityQuerySpec = {
  recursive: boolean;
  prelude: SqlFragment;
  userFrom: SqlFragment;
  userDirectExpr: SqlFragment;
  userWhere: SqlFragment;
  groupFrom: SqlFragment;
  groupDirectExpr: SqlFragment;
  groupWhere: SqlFragment;
};

const buildNoRelationSpec = (): EntityQuerySpec => ({
  recursive: false,
  prelude: sql`scope_seed AS (SELECT 1 AS seed)`,
  userFrom: sql`FROM auth.users u`,
  userDirectExpr: sql`NULL::boolean`,
  userWhere: sql`TRUE`,
  groupFrom: sql`FROM auth.groups g`,
  groupDirectExpr: sql`NULL::boolean`,
  groupWhere: sql`TRUE`,
});

const buildMemberOfGroupSpec = (groupId: string, recursive: boolean): EntityQuerySpec => {
  if (recursive) {
    return {
      recursive: true,
      prelude: sql`
        target_group AS (
          SELECT id, provider
          FROM auth.groups
          WHERE id = ${groupId}::uuid
        ),
        member_group_tree AS (
          SELECT gg.child_group_id AS group_id
          FROM target_group tg
          JOIN auth.group_groups_v2 gg ON gg.parent_group_id = tg.id
          JOIN auth.groups g_child ON g_child.id = gg.child_group_id
          WHERE g_child.provider = tg.provider
          UNION
          SELECT gg.child_group_id AS group_id
          FROM auth.group_groups_v2 gg
          JOIN auth.groups g_child ON g_child.id = gg.child_group_id
          JOIN member_group_tree tree ON gg.parent_group_id = tree.group_id
          JOIN target_group tg ON TRUE
          WHERE g_child.provider = tg.provider
        ),
        member_user_rel AS (
          SELECT ug.user_id AS entity_id, TRUE AS direct
          FROM auth.user_groups_v2 ug
          JOIN target_group tg ON ug.group_id = tg.id
          JOIN auth.users u ON u.id = ug.user_id
          WHERE tg.provider <> 'ipa' OR u.provider = 'ipa'
          UNION ALL
          SELECT ug.user_id AS entity_id, FALSE AS direct
          FROM auth.user_groups_v2 ug
          JOIN member_group_tree tree ON ug.group_id = tree.group_id
          JOIN target_group tg ON TRUE
          JOIN auth.users u ON u.id = ug.user_id
          WHERE tg.provider <> 'ipa' OR u.provider = 'ipa'
        ),
        member_group_rel AS (
          SELECT gg.child_group_id AS entity_id, TRUE AS direct
          FROM target_group tg
          JOIN auth.group_groups_v2 gg ON gg.parent_group_id = tg.id
          JOIN auth.groups g ON g.id = gg.child_group_id
          WHERE g.provider = tg.provider
          UNION ALL
          SELECT tree.group_id AS entity_id, FALSE AS direct
          FROM member_group_tree tree
        ),
        relation_rows AS (
          SELECT 'user'::text AS kind, entity_id, BOOL_OR(direct) AS direct
          FROM member_user_rel
          GROUP BY entity_id
          UNION ALL
          SELECT 'group'::text AS kind, entity_id, BOOL_OR(direct) AS direct
          FROM member_group_rel
          GROUP BY entity_id
        )
      `,
      userFrom: sql`FROM auth.users u JOIN relation_rows rr ON rr.kind = 'user' AND rr.entity_id = u.id`,
      userDirectExpr: sql`rr.direct`,
      userWhere: sql`TRUE`,
      groupFrom: sql`FROM auth.groups g JOIN relation_rows rr ON rr.kind = 'group' AND rr.entity_id = g.id`,
      groupDirectExpr: sql`rr.direct`,
      groupWhere: sql`TRUE`,
    };
  }

  return {
    recursive: false,
    prelude: sql`
      target_group AS (
        SELECT id, provider
        FROM auth.groups
        WHERE id = ${groupId}::uuid
      ),
      relation_rows AS (
        SELECT 'user'::text AS kind, ug.user_id AS entity_id, TRUE AS direct
        FROM auth.user_groups_v2 ug
        JOIN target_group tg ON ug.group_id = tg.id
        JOIN auth.users u ON u.id = ug.user_id
        WHERE tg.provider <> 'ipa' OR u.provider = 'ipa'
        UNION ALL
        SELECT 'group'::text AS kind, gg.child_group_id AS entity_id, TRUE AS direct
        FROM target_group tg
        JOIN auth.group_groups_v2 gg ON gg.parent_group_id = tg.id
        JOIN auth.groups g ON g.id = gg.child_group_id
        WHERE g.provider = tg.provider
      )
    `,
    userFrom: sql`FROM auth.users u JOIN relation_rows rr ON rr.kind = 'user' AND rr.entity_id = u.id`,
    userDirectExpr: sql`rr.direct`,
    userWhere: sql`TRUE`,
    groupFrom: sql`FROM auth.groups g JOIN relation_rows rr ON rr.kind = 'group' AND rr.entity_id = g.id`,
    groupDirectExpr: sql`rr.direct`,
    groupWhere: sql`TRUE`,
  };
};

const buildManagerOfGroupSpec = (groupId: string, recursive: boolean): EntityQuerySpec => {
  if (recursive) {
    return {
      recursive: true,
      prelude: sql`
        target_group AS (
          SELECT id, provider
          FROM auth.groups
          WHERE id = ${groupId}::uuid
        ),
        manager_group_tree AS (
          SELECT gmg.manager_group_id AS group_id
          FROM target_group tg
          JOIN auth.group_manager_groups_v2 gmg ON gmg.group_id = tg.id
          JOIN auth.groups g_manager ON g_manager.id = gmg.manager_group_id
          WHERE g_manager.provider = tg.provider
          UNION
          SELECT gg.parent_group_id AS group_id
          FROM auth.group_groups_v2 gg
          JOIN auth.groups g_parent ON g_parent.id = gg.parent_group_id
          JOIN manager_group_tree tree ON gg.child_group_id = tree.group_id
          JOIN target_group tg ON TRUE
          WHERE g_parent.provider = tg.provider
        ),
        manager_user_rel AS (
          SELECT gmu.user_id AS entity_id, TRUE AS direct
          FROM auth.group_manager_users_v2 gmu
          JOIN target_group tg ON gmu.group_id = tg.id
          JOIN auth.users u ON u.id = gmu.user_id
          WHERE tg.provider <> 'ipa' OR u.provider = 'ipa'
          UNION ALL
          SELECT ug.user_id AS entity_id, FALSE AS direct
          FROM auth.user_groups_v2 ug
          JOIN manager_group_tree tree ON ug.group_id = tree.group_id
          JOIN target_group tg ON TRUE
          JOIN auth.users u ON u.id = ug.user_id
          WHERE tg.provider <> 'ipa' OR u.provider = 'ipa'
        ),
        manager_group_rel AS (
          SELECT gmg.manager_group_id AS entity_id, TRUE AS direct
          FROM target_group tg
          JOIN auth.group_manager_groups_v2 gmg ON gmg.group_id = tg.id
          JOIN auth.groups g ON g.id = gmg.manager_group_id
          WHERE g.provider = tg.provider
          UNION ALL
          SELECT tree.group_id AS entity_id, FALSE AS direct
          FROM manager_group_tree tree
        ),
        relation_rows AS (
          SELECT 'user'::text AS kind, entity_id, BOOL_OR(direct) AS direct
          FROM manager_user_rel
          GROUP BY entity_id
          UNION ALL
          SELECT 'group'::text AS kind, entity_id, BOOL_OR(direct) AS direct
          FROM manager_group_rel
          GROUP BY entity_id
        )
      `,
      userFrom: sql`FROM auth.users u JOIN relation_rows rr ON rr.kind = 'user' AND rr.entity_id = u.id`,
      userDirectExpr: sql`rr.direct`,
      userWhere: sql`TRUE`,
      groupFrom: sql`FROM auth.groups g JOIN relation_rows rr ON rr.kind = 'group' AND rr.entity_id = g.id`,
      groupDirectExpr: sql`rr.direct`,
      groupWhere: sql`TRUE`,
    };
  }

  return {
    recursive: false,
    prelude: sql`
      target_group AS (
        SELECT id, provider
        FROM auth.groups
        WHERE id = ${groupId}::uuid
      ),
      relation_rows AS (
        SELECT 'user'::text AS kind, gmu.user_id AS entity_id, TRUE AS direct
        FROM auth.group_manager_users_v2 gmu
        JOIN target_group tg ON gmu.group_id = tg.id
        JOIN auth.users u ON u.id = gmu.user_id
        WHERE tg.provider <> 'ipa' OR u.provider = 'ipa'
        UNION ALL
        SELECT 'group'::text AS kind, gmg.manager_group_id AS entity_id, TRUE AS direct
        FROM target_group tg
        JOIN auth.group_manager_groups_v2 gmg ON gmg.group_id = tg.id
        JOIN auth.groups g ON g.id = gmg.manager_group_id
        WHERE g.provider = tg.provider
      )
    `,
    userFrom: sql`FROM auth.users u JOIN relation_rows rr ON rr.kind = 'user' AND rr.entity_id = u.id`,
    userDirectExpr: sql`rr.direct`,
    userWhere: sql`TRUE`,
    groupFrom: sql`FROM auth.groups g JOIN relation_rows rr ON rr.kind = 'group' AND rr.entity_id = g.id`,
    groupDirectExpr: sql`rr.direct`,
    groupWhere: sql`TRUE`,
  };
};

const buildParentGroupSpec = (groupId: string, recursive: boolean): EntityQuerySpec => {
  if (recursive) {
    return {
      recursive: true,
      prelude: sql`
        target_group AS (
          SELECT id, provider
          FROM auth.groups
          WHERE id = ${groupId}::uuid
        ),
        parent_group_tree AS (
          SELECT gg.parent_group_id AS group_id
          FROM target_group tg
          JOIN auth.group_groups_v2 gg ON gg.child_group_id = tg.id
          JOIN auth.groups g_parent ON g_parent.id = gg.parent_group_id
          WHERE g_parent.provider = tg.provider
          UNION
          SELECT gg.parent_group_id AS group_id
          FROM auth.group_groups_v2 gg
          JOIN auth.groups g_parent ON g_parent.id = gg.parent_group_id
          JOIN parent_group_tree tree ON gg.child_group_id = tree.group_id
          JOIN target_group tg ON TRUE
          WHERE g_parent.provider = tg.provider
        ),
        parent_group_rel AS (
          SELECT gg.parent_group_id AS entity_id, TRUE AS direct
          FROM target_group tg
          JOIN auth.group_groups_v2 gg ON gg.child_group_id = tg.id
          JOIN auth.groups g_parent ON g_parent.id = gg.parent_group_id
          WHERE g_parent.provider = tg.provider
          UNION ALL
          SELECT tree.group_id AS entity_id, FALSE AS direct
          FROM parent_group_tree tree
        ),
        relation_rows AS (
          SELECT 'group'::text AS kind, entity_id, BOOL_OR(direct) AS direct
          FROM parent_group_rel
          GROUP BY entity_id
        )
      `,
      userFrom: sql`FROM auth.users u JOIN relation_rows rr ON rr.kind = 'user' AND rr.entity_id = u.id`,
      userDirectExpr: sql`rr.direct`,
      userWhere: sql`FALSE`,
      groupFrom: sql`FROM auth.groups g JOIN relation_rows rr ON rr.kind = 'group' AND rr.entity_id = g.id`,
      groupDirectExpr: sql`rr.direct`,
      groupWhere: sql`TRUE`,
    };
  }

  return {
    recursive: false,
    prelude: sql`
      target_group AS (
        SELECT id, provider
        FROM auth.groups
        WHERE id = ${groupId}::uuid
      ),
      relation_rows AS (
        SELECT 'group'::text AS kind, gg.parent_group_id AS entity_id, TRUE AS direct
        FROM target_group tg
        JOIN auth.group_groups_v2 gg ON gg.child_group_id = tg.id
        JOIN auth.groups g_parent ON g_parent.id = gg.parent_group_id
        WHERE g_parent.provider = tg.provider
      )
    `,
    userFrom: sql`FROM auth.users u JOIN relation_rows rr ON rr.kind = 'user' AND rr.entity_id = u.id`,
    userDirectExpr: sql`rr.direct`,
    userWhere: sql`FALSE`,
    groupFrom: sql`FROM auth.groups g JOIN relation_rows rr ON rr.kind = 'group' AND rr.entity_id = g.id`,
    groupDirectExpr: sql`rr.direct`,
    groupWhere: sql`TRUE`,
  };
};

const buildManagedByUserSpec = (userId: string, recursive: boolean): EntityQuerySpec => {
  const directCondition = sql`
    (
      g.id IN (
        SELECT DISTINCT g_manage.id
        FROM auth.groups g_manage
        LEFT JOIN auth.group_manager_users_v2 gmu ON gmu.group_id = g_manage.id AND gmu.user_id = ${userId}::uuid
        LEFT JOIN auth.group_manager_groups_v2 gmg ON gmg.group_id = g_manage.id
        LEFT JOIN auth.user_groups_v2 ug ON ug.group_id = gmg.manager_group_id AND ug.user_id = ${userId}::uuid
        LEFT JOIN auth.groups g_manager ON g_manager.id = gmg.manager_group_id
        WHERE g_manage.provider = g.provider
          AND (gmu.user_id IS NOT NULL OR (ug.user_id IS NOT NULL AND g_manager.provider = g_manage.provider))
      )
    )
  `;

  return {
    recursive: false,
    prelude: sql`scope_seed AS (SELECT 1 AS seed)`,
    userFrom: sql`FROM auth.users u`,
    userDirectExpr: sql`NULL::boolean`,
    userWhere: sql`FALSE`,
    groupFrom: sql`FROM auth.groups g`,
    groupDirectExpr: sql`NULL::boolean`,
    groupWhere: recursive ? buildManagedGroupScopeCondition({ userId, groupProvider: sql`g.provider` }) : directCondition,
  };
};

const buildQuerySpec = (params: EntityListParams): EntityQuerySpec => {
  const relationFilters = [params.memberOfGroupId, params.managerOfGroupId, params.parentGroupId, params.managedByUserId].filter(Boolean);

  if (relationFilters.length > 1) {
    throw new Error("Only one relation filter can be used at a time.");
  }

  if (params.memberOfGroupId) return buildMemberOfGroupSpec(params.memberOfGroupId, Boolean(params.recursive));
  if (params.managerOfGroupId) return buildManagerOfGroupSpec(params.managerOfGroupId, Boolean(params.recursive));
  if (params.parentGroupId) return buildParentGroupSpec(params.parentGroupId, Boolean(params.recursive));
  if (params.managedByUserId) return buildManagedByUserSpec(params.managedByUserId, params.recursive !== false);
  return buildNoRelationSpec();
};

const mapEntityRow = (row: DbRow): EntityListItem => {
  const direct = typeof row.direct === "boolean" ? row.direct : undefined;

  if (row.kind === "user") {
    return {
      kind: "user",
      user: buildBaseUser(row),
      relation: direct === undefined ? undefined : { direct },
    };
  }

  if (row.kind === "service_account") {
    return {
      kind: "service_account",
      serviceAccount: {
        id: String(row.id),
        name: String(row.name ?? ""),
        kind: row.service_account_kind === "resource_bound" ? "resource_bound" : "user_delegated",
        status: row.status === "disabled" ? "disabled" : "active",
        delegatedUserId: typeof row.delegated_user_id === "string" ? row.delegated_user_id : null,
        appId: typeof row.app_id === "string" ? row.app_id : null,
        resourceType: typeof row.resource_type === "string" ? row.resource_type : null,
        resourceId: typeof row.resource_id === "string" ? row.resource_id : null,
        createdBy: typeof row.created_by === "string" ? row.created_by : null,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      },
      relation: direct === undefined ? undefined : { direct },
    };
  }

  return {
    kind: "group",
    group: buildBaseGroup(row),
    relation: direct === undefined ? undefined : { direct },
  };
};

export const list = async (
  params: EntityListParams,
): Promise<{
  items: EntityListItem[];
  total: number;
  pagination: { page: number; perPage: number; totalPages: number; hasNext: boolean };
}> => {
  const page = params.page ?? 1;
  const perPage = params.perPage ?? 100;
  const offset = (page - 1) * perPage;
  const pattern = params.search ? `%${escapeLikePattern(params.search.trim().toLowerCase())}%` : null;
  const groupsAdmin = (await getFreeIpaConfig()).groupsAdmin;
  const groupsAdminLiteral = toPgTextArray(groupsAdmin);
  const spec = buildQuerySpec(params);
  const includePersonal =
    params.includePersonal === true ||
    params.groupIds !== undefined ||
    Boolean(params.memberOfGroupId || params.managerOfGroupId || params.parentGroupId || params.managedByUserId);
  const personalCondition = includePersonal ? sql`TRUE` : sql`(kind <> 'group' OR personal_owner_id IS NULL)`;
  const visibilityCondition =
    params.visibility.type === "directory"
      ? sql`TRUE`
      : sql`(
          (kind = 'user' AND id = ${params.visibility.userId}::uuid)
          OR (
            kind = 'group'
            AND id IN (${recursiveGroupIdsSubquery(params.visibility.userId)})
          )
        )`;
  const kindsCondition = (params.kinds?.length ?? 0) === 0 ? sql`TRUE` : sql`kind = ANY(${toPgTextArray(params.kinds ?? [])}::text[])`;
  const hasIdFilter = params.userIds !== undefined || params.groupIds !== undefined;
  const includeIdCondition = !hasIdFilter
    ? sql`TRUE`
    : sql`(
        (kind = 'user' AND id = ANY(${toPgUuidArray(params.userIds ?? [])}::uuid[]))
        OR (kind = 'group' AND id = ANY(${toPgUuidArray(params.groupIds ?? [])}::uuid[]))
      )`;
  const excludeUserCondition =
    (params.excludeUserIds?.length ?? 0) === 0
      ? sql`TRUE`
      : sql`(kind <> 'user' OR id <> ALL(${toPgUuidArray(params.excludeUserIds ?? [])}::uuid[]))`;
  const excludeGroupCondition =
    (params.excludeGroupIds?.length ?? 0) === 0
      ? sql`TRUE`
      : sql`(kind <> 'group' OR id <> ALL(${toPgUuidArray(params.excludeGroupIds ?? [])}::uuid[]))`;
  const excludeServiceAccountCondition =
    (params.excludeServiceAccountIds?.length ?? 0) === 0
      ? sql`TRUE`
      : sql`(kind <> 'service_account' OR id <> ALL(${toPgUuidArray(params.excludeServiceAccountIds ?? [])}::uuid[]))`;
  const userMemberOfGroupCondition =
    (params.userMemberOfGroupIds?.length ?? 0) === 0
      ? sql`TRUE`
      : sql`(kind <> 'user' OR EXISTS (
          SELECT 1
          FROM auth.user_groups_v2 ug
          WHERE ug.user_id = id
            AND ug.group_id = ANY(${toPgUuidArray(params.userMemberOfGroupIds ?? [])}::uuid[])
        ))`;

  const where = sql`
    ${visibilityCondition}
    AND ${kindsCondition}
    AND ${includeIdCondition}
    AND (${params.provider ?? null}::text IS NULL OR provider = ${params.provider ?? null})
    AND (${params.profile ?? null}::text IS NULL OR kind = 'group' OR profile = ${params.profile ?? null})
    AND ${excludeUserCondition}
    AND ${excludeGroupCondition}
    AND ${excludeServiceAccountCondition}
    AND ${userMemberOfGroupCondition}
    AND ${personalCondition}
    AND (
      ${pattern}::text IS NULL
      OR (
        kind = 'user' AND (
          LOWER(uid) LIKE ${pattern} ESCAPE '\\'
          OR LOWER(COALESCE(display_name, '')) LIKE ${pattern} ESCAPE '\\'
          OR LOWER(COALESCE(given_name, '')) LIKE ${pattern} ESCAPE '\\'
          OR LOWER(COALESCE(sn, '')) LIKE ${pattern} ESCAPE '\\'
          OR LOWER(COALESCE(mail, '')) LIKE ${pattern} ESCAPE '\\'
        )
      )
      OR (
        kind = 'group' AND (
          LOWER(name) LIKE ${pattern} ESCAPE '\\'
          OR LOWER(COALESCE(description, '')) LIKE ${pattern} ESCAPE '\\'
        )
      )
      OR (
        kind = 'service_account' AND (
          LOWER(name) LIKE ${pattern} ESCAPE '\\'
          OR LOWER(COALESCE(app_id, '')) LIKE ${pattern} ESCAPE '\\'
          OR LOWER(COALESCE(resource_type, '')) LIKE ${pattern} ESCAPE '\\'
          OR LOWER(COALESCE(resource_id, '')) LIKE ${pattern} ESCAPE '\\'
        )
      )
    )
  `;

  const rows = await sql<DbRow[]>`
    WITH ${spec.recursive ? sql`RECURSIVE` : sql``}
      ${spec.prelude},
      user_rows AS (
        SELECT
          'user'::text AS kind,
          ${spec.userDirectExpr} AS direct,
          u.id,
          u.provider,
          u.profile,
          u.uid,
          u.given_name,
          u.sn,
          u.display_name,
          u.mail,
          u.avatar_hash,
          NULL::text AS name,
          NULL::text AS description,
          NULL::int AS gid_number,
          CASE
            WHEN u.provider = 'local' THEN u.admin
            ELSE EXISTS(
              SELECT 1
              FROM auth.ipa_user_effective_groups eg
              WHERE eg.user_id = u.id
                AND eg.group_name = ANY(${groupsAdminLiteral}::text[])
            )
          END AS effective_admin,
          NULL::text AS service_account_kind,
          NULL::text AS status,
          NULL::uuid AS delegated_user_id,
          NULL::text AS app_id,
          NULL::text AS resource_type,
          NULL::text AS resource_id,
          NULL::uuid AS created_by,
          NULL::timestamptz AS created_at,
          NULL::uuid AS personal_owner_id,
          NULL::text AS personal_owner_uid,
          NULL::text AS personal_owner_display_name,
          LOWER(COALESCE(NULLIF(u.display_name, ''), NULLIF(u.mail, ''), u.uid)) AS sort_label
        ${spec.userFrom}
        WHERE ${spec.userWhere}
      ),
      group_rows AS (
        SELECT
          'group'::text AS kind,
          ${spec.groupDirectExpr} AS direct,
          g.id,
          g.provider,
          NULL::text AS profile,
          NULL::text AS uid,
          NULL::text AS given_name,
          NULL::text AS sn,
          NULL::text AS display_name,
          NULL::text AS mail,
          NULL::text AS avatar_hash,
          g.name,
          g.description,
          g.gid_number,
          NULL::boolean AS effective_admin,
          NULL::text AS service_account_kind,
          NULL::text AS status,
          NULL::uuid AS delegated_user_id,
          NULL::text AS app_id,
          NULL::text AS resource_type,
          NULL::text AS resource_id,
          NULL::uuid AS created_by,
          NULL::timestamptz AS created_at,
          personal_owner.personal_owner_id,
          personal_owner.personal_owner_uid,
          personal_owner.personal_owner_display_name,
          LOWER(g.name) AS sort_label
        ${spec.groupFrom}
        ${personalOwnerJoin()}
        WHERE ${spec.groupWhere}
      ),
      service_account_rows AS (
        SELECT
          'service_account'::text AS kind,
          NULL::boolean AS direct,
          sa.id,
          NULL::text AS provider,
          NULL::text AS profile,
          NULL::text AS uid,
          NULL::text AS given_name,
          NULL::text AS sn,
          NULL::text AS display_name,
          NULL::text AS mail,
          NULL::text AS avatar_hash,
          sa.name,
          CASE
            WHEN sa.kind = 'user_delegated' THEN 'Personal automation keys'
            ELSE CONCAT_WS(' · ', sa.app_id, sa.resource_type, sa.resource_id)
          END AS description,
          NULL::int AS gid_number,
          NULL::boolean AS effective_admin,
          sa.kind AS service_account_kind,
          sa.status,
          sa.delegated_user_id,
          sa.app_id,
          sa.resource_type,
          sa.resource_id,
          sa.created_by,
          sa.created_at,
          NULL::uuid AS personal_owner_id,
          NULL::text AS personal_owner_uid,
          NULL::text AS personal_owner_display_name,
          LOWER(sa.name) AS sort_label
        FROM auth.service_accounts sa
      ),
      entity_rows AS (
        SELECT * FROM user_rows
        UNION ALL
        SELECT * FROM group_rows
        UNION ALL
        SELECT * FROM service_account_rows
      )
    SELECT *, COUNT(*) OVER() AS total
    FROM entity_rows
    WHERE ${where}
    ORDER BY sort_label, kind, id
    LIMIT ${perPage}
    OFFSET ${offset}
  `;

  const total = rows.length > 0 ? Number((rows[0] as Record<string, unknown>).total) : 0;
  return {
    items: rows.map(mapEntityRow),
    total,
    pagination: {
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
      hasNext: page * perPage < total,
    },
  };
};
