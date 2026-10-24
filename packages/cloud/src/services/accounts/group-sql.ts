import { type SQLQuery, sql } from "bun";

type SqlFragment = SQLQuery;
type SqlValue = SQLQuery | string;

export const recursiveUserGroupsSubquery = (params: { userId: SqlValue; select: SqlFragment }) => sql`
  WITH RECURSIVE user_all_groups AS (
    SELECT ug.group_id, g.provider
    FROM auth.user_groups_v2 ug
    JOIN auth.groups g ON g.id = ug.group_id
    WHERE ug.user_id = ${params.userId}::uuid
    UNION
    SELECT gg.parent_group_id, g_parent.provider
    FROM auth.group_groups_v2 gg
    JOIN auth.groups g_parent ON g_parent.id = gg.parent_group_id
    JOIN user_all_groups ag ON gg.child_group_id = ag.group_id
    WHERE g_parent.provider = ag.provider
  )
  ${params.select}
`;

export const managedGroupsNamesSubquery = (userId: SqlValue) =>
  recursiveUserGroupsSubquery({
    userId,
    select: sql`
      SELECT DISTINCT g.name
      FROM auth.groups g
      LEFT JOIN auth.group_manager_users_v2 gmu ON gmu.group_id = g.id AND gmu.user_id = ${userId}::uuid
      LEFT JOIN auth.group_manager_groups_v2 gmg ON gmg.group_id = g.id
      LEFT JOIN user_all_groups ug ON ug.group_id = gmg.manager_group_id AND ug.provider = g.provider
      WHERE gmu.user_id IS NOT NULL OR ug.group_id IS NOT NULL
      ORDER BY g.name
    `,
  });

export const managedGroupIdsSubquery = (userId: SqlValue) =>
  recursiveUserGroupsSubquery({
    userId,
    select: sql`
      SELECT managed.id
      FROM (
        SELECT DISTINCT g.id, g.name
        FROM auth.groups g
        LEFT JOIN auth.group_manager_users_v2 gmu ON gmu.group_id = g.id AND gmu.user_id = ${userId}::uuid
        LEFT JOIN auth.group_manager_groups_v2 gmg ON gmg.group_id = g.id
        LEFT JOIN user_all_groups ug ON ug.group_id = gmg.manager_group_id AND ug.provider = g.provider
        WHERE gmu.user_id IS NOT NULL OR ug.group_id IS NOT NULL
      ) managed
      ORDER BY managed.name
    `,
  });

export const recursiveGroupNamesSubquery = (userId: SqlValue) =>
  recursiveUserGroupsSubquery({
    userId,
    select: sql`
      SELECT DISTINCT g.name
      FROM user_all_groups ag
      JOIN auth.groups g ON g.id = ag.group_id
      ORDER BY g.name
    `,
  });

export const recursiveGroupIdsSubquery = (userId: SqlValue) =>
  recursiveUserGroupsSubquery({
    userId,
    select: sql`
      SELECT group_ids.group_id
      FROM (
        SELECT DISTINCT g.id AS group_id, g.name
        FROM user_all_groups ag
        JOIN auth.groups g ON g.id = ag.group_id
      ) group_ids
      ORDER BY group_ids.name
    `,
  });

export const buildMemberGroupScopeCondition = (params: { userId: SqlValue; groupProvider: SqlFragment }) => sql`
  g.id IN (
    ${recursiveUserGroupsSubquery({
      userId: params.userId,
      select: sql`
        SELECT DISTINCT ug.group_id
        FROM user_all_groups ug
        WHERE ug.provider = ${params.groupProvider}
      `,
    })}
  )
`;

export const buildManagedGroupScopeCondition = (params: { userId: SqlValue; groupProvider: SqlFragment }) => sql`
  g.id IN (
    ${recursiveUserGroupsSubquery({
      userId: params.userId,
      select: sql`
        SELECT DISTINCT g_manage.id
        FROM auth.groups g_manage
        LEFT JOIN auth.group_manager_users_v2 gmu ON gmu.group_id = g_manage.id AND gmu.user_id = ${params.userId}::uuid
        LEFT JOIN auth.group_manager_groups_v2 gmg ON gmg.group_id = g_manage.id
        LEFT JOIN user_all_groups ug ON ug.group_id = gmg.manager_group_id AND ug.provider = g_manage.provider
        WHERE g_manage.provider = ${params.groupProvider}
          AND (gmu.user_id IS NOT NULL OR ug.group_id IS NOT NULL)
      `,
    })}
  )
`;

/** Local recipient membership only; never supplies user roles or directory identity. */
export const recursiveServiceAccountGroupIdsSubquery = (serviceAccountId: SqlValue) => sql`
  WITH RECURSIVE account_subject AS (
    -- Resolve a correlated column before introducing aliases used by directory callers (for example sa.id).
    SELECT ${serviceAccountId}::uuid AS id
  ), account_groups AS (
    SELECT sg.group_id
    FROM auth.service_account_groups sg
    JOIN auth.service_accounts sa ON sa.id = sg.service_account_id
    JOIN account_subject subject ON subject.id = sa.id
    JOIN auth.groups g ON g.id = sg.group_id
    WHERE sa.status = 'active' AND sa.kind IN ('standalone', 'agent')
      AND g.provider = 'local'
    UNION
    SELECT gg.parent_group_id
    FROM auth.group_groups_v2 gg
    JOIN auth.groups parent ON parent.id = gg.parent_group_id
    JOIN account_groups ag ON ag.group_id = gg.child_group_id
    WHERE parent.provider = 'local'
  )
  SELECT group_id FROM account_groups
`;
