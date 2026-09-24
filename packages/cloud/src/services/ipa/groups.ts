import { sql } from "bun";
import type { BaseGroup, GroupMember, MutationResult } from "../../contracts/shared";
import { freeipa } from "../../server/services";
import { toPgUuidArray } from "../postgres";
import { ensureFreeIpaMutationAvailable, getIpaUrl } from "./guard";
import { updateProfileForAffectedUsers, updateUserIpaProfile } from "./profile";

type DbRow = Record<string, unknown>;

type IpaGroupRow = {
  id: string;
  cn: string;
  name: string;
  provider: "ipa" | "local";
  description: string | null;
  gidNumber: number | null;
};

const toBaseGroup = (row: IpaGroupRow): BaseGroup => ({
  id: row.id,
  provider: row.provider,
  name: row.name,
  description: row.description,
  gidnumber: row.gidNumber,
  personalOwner: null,
});

const getIpaGroupById = async (id: string): Promise<IpaGroupRow | null> => {
  const [row] = await sql<DbRow[]>`
    SELECT id, cn, name, provider, description, gid_number
    FROM auth.groups
    WHERE id = ${id} AND provider = 'ipa'
  `;
  if (!row) return null;
  return {
    id: row.id as string,
    cn: row.cn as string,
    name: row.name as string,
    provider: row.provider as "ipa" | "local",
    description: row.description as string | null,
    gidNumber: row.gid_number as number | null,
  };
};

const getIpaGroupIdByCn = async (cn: string): Promise<string | null> => {
  const [row] = await sql<DbRow[]>`SELECT id FROM auth.groups WHERE cn = ${cn} AND provider = 'ipa'`;
  return (row?.id as string | undefined) ?? null;
};

const ipaMutationError = (response: Awaited<ReturnType<typeof freeipa.client.call>>): MutationResult<never> => ({
  ok: false,
  error: response.error?.message ?? "FreeIPA request failed",
  status: response.error ? freeipa.util.mapIpaErrorCode(response.error.code) : 500,
});

export const get = async (params: { id: string }): Promise<BaseGroup | null> => {
  const row = await getIpaGroupById(params.id);
  return row ? toBaseGroup(row) : null;
};

export const list = async (params: {
  ids?: string[];
  userId?: string;
  search?: string;
  page?: number;
  perPage?: number;
}): Promise<{
  groups: BaseGroup[];
  total: number;
  pagination: {
    page: number;
    perPage: number;
    totalPages: number;
    hasNext: boolean;
  };
}> => {
  const page = params.page ?? 1;
  const perPage = params.perPage ?? 100;
  const offset = (page - 1) * perPage;
  const search = params.search ? `%${freeipa.util.escapeLike(params.search.toLowerCase())}%` : null;
  const ids = params.ids;

  if (ids && ids.length === 0) {
    return {
      groups: [],
      total: 0,
      pagination: { page, perPage, totalPages: 0, hasNext: false },
    };
  }

  const conditions = [sql`g.provider = 'ipa'`];
  if (ids) conditions.push(sql`g.id = ANY(${toPgUuidArray(ids)}::uuid[])`);
  if (search) conditions.push(sql`(LOWER(g.name) LIKE ${search} ESCAPE '\\' OR LOWER(g.description) LIKE ${search} ESCAPE '\\')`);
  if (params.userId) {
    conditions.push(sql`(
      g.id IN (
        SELECT ug.group_id
        FROM auth.user_groups_v2 ug
        JOIN auth.groups g_filter ON g_filter.id = ug.group_id
        WHERE ug.user_id = ${params.userId} AND g_filter.provider = 'ipa'
      )
      OR g.id IN (
        WITH RECURSIVE user_all_groups AS (
          SELECT ug.group_id
          FROM auth.user_groups_v2 ug
          JOIN auth.groups g_filter ON g_filter.id = ug.group_id
          WHERE ug.user_id = ${params.userId} AND g_filter.provider = 'ipa'
          UNION
          SELECT gg.parent_group_id
          FROM auth.group_groups_v2 gg
          JOIN auth.groups g_parent ON g_parent.id = gg.parent_group_id
          JOIN user_all_groups ag ON gg.child_group_id = ag.group_id
          WHERE g_parent.provider = 'ipa'
        )
        SELECT DISTINCT g_manage.id
        FROM auth.groups g_manage
        LEFT JOIN auth.group_manager_users_v2 gmu ON gmu.group_id = g_manage.id AND gmu.user_id = ${params.userId}
        LEFT JOIN auth.group_manager_groups_v2 gmg ON gmg.group_id = g_manage.id
        LEFT JOIN user_all_groups ug ON ug.group_id = gmg.manager_group_id
        WHERE g_manage.provider = 'ipa' AND (gmu.user_id IS NOT NULL OR ug.group_id IS NOT NULL)
      )
    )`);
  }

  const where = conditions.reduce((acc, condition) => sql`${acc} AND ${condition}`);

  const [countRow] = await sql<DbRow[]>`SELECT COUNT(*)::int AS count FROM auth.groups g WHERE ${where}`;
  const total = Number(countRow?.count ?? 0);
  const totalPages = Math.ceil(total / perPage);

  const rows = await sql<DbRow[]>`
    SELECT g.id, g.provider, g.name, g.description, g.gid_number
    FROM auth.groups g
    WHERE ${where}
    ORDER BY g.name
    LIMIT ${perPage} OFFSET ${offset}
  `;

  return {
    groups: rows.map((row) => ({
      id: row.id as string,
      provider: row.provider as "ipa" | "local",
      name: row.name as string,
      description: row.description as string | null,
      gidnumber: row.gid_number as number | null,
      personalOwner: null,
    })),
    total,
    pagination: { page, perPage, totalPages, hasNext: page < totalPages },
  };
};

export const getMembers = async (params: { id: string; type?: "user" | "group"; recursive?: boolean }): Promise<GroupMember[]> => {
  const group = await getIpaGroupById(params.id);
  if (!group) return [];

  const members: GroupMember[] = [];

  if (!params.type || params.type === "user") {
    const userRows = params.recursive
      ? await sql<DbRow[]>`
          WITH RECURSIVE child_groups AS (
            SELECT ${group.id}::uuid AS group_id
            UNION
            SELECT gg.child_group_id
            FROM auth.group_groups_v2 gg
            JOIN auth.groups g_child ON g_child.id = gg.child_group_id
            JOIN child_groups cg ON gg.parent_group_id = cg.group_id
            WHERE g_child.provider = 'ipa'
          )
          SELECT DISTINCT u.id, u.uid, u.display_name
          FROM auth.user_groups_v2 ug
          JOIN child_groups cg ON ug.group_id = cg.group_id
          JOIN auth.users u ON u.id = ug.user_id
          WHERE u.provider = 'ipa'
          ORDER BY u.uid
        `
      : await sql<DbRow[]>`
          SELECT u.id, u.uid, u.display_name
          FROM auth.user_groups_v2 ug
          JOIN auth.users u ON u.id = ug.user_id
          WHERE ug.group_id = ${group.id} AND u.provider = 'ipa'
          ORDER BY u.uid
        `;

    for (const row of userRows) {
      members.push({ type: "user", id: row.id as string, displayName: (row.display_name as string | null) ?? (row.uid as string) });
    }
  }

  if (!params.type || params.type === "group") {
    const groupRows = params.recursive
      ? await sql<DbRow[]>`
          WITH RECURSIVE child_groups AS (
            SELECT gg.child_group_id AS group_id
            FROM auth.group_groups_v2 gg
            JOIN auth.groups g_child ON g_child.id = gg.child_group_id
            WHERE gg.parent_group_id = ${group.id} AND g_child.provider = 'ipa'
            UNION
            SELECT gg.child_group_id AS group_id
            FROM auth.group_groups_v2 gg
            JOIN auth.groups g_child ON g_child.id = gg.child_group_id
            JOIN child_groups cg ON gg.parent_group_id = cg.group_id
            WHERE g_child.provider = 'ipa'
          )
          SELECT DISTINCT g.id, g.name, g.description
          FROM child_groups cg
          JOIN auth.groups g ON g.id = cg.group_id
          WHERE g.provider = 'ipa'
          ORDER BY g.name
        `
      : await sql<DbRow[]>`
          SELECT g.id, g.name, g.description
          FROM auth.group_groups_v2 gg
          JOIN auth.groups g ON g.id = gg.child_group_id
          WHERE gg.parent_group_id = ${group.id} AND g.provider = 'ipa'
          ORDER BY g.name
        `;

    for (const row of groupRows) {
      members.push({ type: "group", id: row.id as string, displayName: row.name as string });
    }
  }

  return members;
};

export const getManagers = async (params: { id: string; type?: "user" | "group"; recursive?: boolean }): Promise<GroupMember[]> => {
  const group = await getIpaGroupById(params.id);
  if (!group) return [];

  const managers: GroupMember[] = [];

  if (!params.type || params.type === "user") {
    const userRows = params.recursive
      ? await sql<DbRow[]>`
          WITH RECURSIVE manager_groups AS (
            SELECT gmg.manager_group_id AS group_id
            FROM auth.group_manager_groups_v2 gmg
            JOIN auth.groups g_manager ON g_manager.id = gmg.manager_group_id
            WHERE gmg.group_id = ${group.id} AND g_manager.provider = 'ipa'
            UNION
            SELECT gg.parent_group_id AS group_id
            FROM auth.group_groups_v2 gg
            JOIN auth.groups g_parent ON g_parent.id = gg.parent_group_id
            JOIN manager_groups mg ON gg.child_group_id = mg.group_id
            WHERE g_parent.provider = 'ipa'
          )
          SELECT DISTINCT u.id, u.uid, u.display_name
          FROM (
            SELECT gmu.user_id
            FROM auth.group_manager_users_v2 gmu
            JOIN auth.users u_direct ON u_direct.id = gmu.user_id
            WHERE gmu.group_id = ${group.id} AND u_direct.provider = 'ipa'
            UNION
            SELECT ug.user_id
            FROM auth.user_groups_v2 ug
            JOIN auth.users u_member ON u_member.id = ug.user_id
            JOIN manager_groups mg ON ug.group_id = mg.group_id
            WHERE u_member.provider = 'ipa'
          ) all_managers
          JOIN auth.users u ON u.id = all_managers.user_id
          ORDER BY u.uid
        `
      : await sql<DbRow[]>`
          SELECT u.id, u.uid, u.display_name
          FROM auth.group_manager_users_v2 gmu
          JOIN auth.users u ON u.id = gmu.user_id
          WHERE gmu.group_id = ${group.id} AND u.provider = 'ipa'
          ORDER BY u.uid
        `;

    for (const row of userRows) {
      managers.push({ type: "user", id: row.id as string, displayName: (row.display_name as string | null) ?? (row.uid as string) });
    }
  }

  if (!params.type || params.type === "group") {
    const groupRows = await sql<DbRow[]>`
      SELECT g.id, g.name, g.description
      FROM auth.group_manager_groups_v2 gmg
      JOIN auth.groups g ON g.id = gmg.manager_group_id
      WHERE gmg.group_id = ${group.id} AND g.provider = 'ipa'
      ORDER BY g.name
    `;

    for (const row of groupRows) {
      managers.push({ type: "group", id: row.id as string, displayName: row.name as string });
    }
  }

  return managers;
};

export const getParents = async (params: { id: string; recursive?: boolean }): Promise<string[]> => {
  const group = await getIpaGroupById(params.id);
  if (!group) return [];

  const rows = params.recursive
    ? await sql<DbRow[]>`
        WITH RECURSIVE parent_groups AS (
          SELECT gg.parent_group_id AS group_id
          FROM auth.group_groups_v2 gg
          JOIN auth.groups g_parent ON g_parent.id = gg.parent_group_id
          WHERE gg.child_group_id = ${group.id} AND g_parent.provider = 'ipa'
          UNION
          SELECT gg.parent_group_id AS group_id
          FROM auth.group_groups_v2 gg
          JOIN auth.groups g_parent ON g_parent.id = gg.parent_group_id
          JOIN parent_groups pg ON gg.child_group_id = pg.group_id
          WHERE g_parent.provider = 'ipa'
        )
        SELECT DISTINCT group_id AS parent_group_id
        FROM parent_groups
      `
    : await sql<DbRow[]>`
        SELECT gg.parent_group_id
        FROM auth.group_groups_v2 gg
        JOIN auth.groups g_parent ON g_parent.id = gg.parent_group_id
        WHERE gg.child_group_id = ${group.id} AND g_parent.provider = 'ipa'
      `;

  return rows.map((row) => row.parent_group_id as string);
};

export const getManagedGroups = async (params: { id: string }): Promise<string[]> => {
  const group = await getIpaGroupById(params.id);
  if (!group) return [];

  const rows = await sql<DbRow[]>`
    SELECT gmg.group_id
    FROM auth.group_manager_groups_v2 gmg
    JOIN auth.groups g ON g.id = gmg.group_id
    WHERE gmg.manager_group_id = ${group.id} AND g.provider = 'ipa'
    ORDER BY g.name
  `;

  return rows.map((row) => row.group_id as string);
};

export const add = async (params: {
  ipaSession: string;
  cn: string;
  description?: string;
  posix?: boolean;
}): Promise<MutationResult<BaseGroup>> => {
  const unavailable = await ensureFreeIpaMutationAvailable();
  if (unavailable) return unavailable;
  const options: Record<string, unknown> = { nonposix: params.posix ? false : true };
  if (params.description) options.description = params.description;

  const response = await freeipa.client.call({
    url: await getIpaUrl(),
    ipaSession: params.ipaSession,
    method: "group_add",
    args: [params.cn],
    options,
  });
  if (response.error) return ipaMutationError(response);

  const gidnumber = freeipa.util.num((response.result?.result as Record<string, unknown> | undefined)?.gidnumber);
  const [row] = await sql<DbRow[]>`
    INSERT INTO auth.groups (id, cn, name, provider, description, gid_number, synced_at)
    VALUES (gen_random_uuid(), ${params.cn}, ${params.cn}, 'ipa', ${params.description ?? null}, ${gidnumber}, now())
    ON CONFLICT (provider, name) DO UPDATE
      SET cn = EXCLUDED.cn,
          description = EXCLUDED.description,
          gid_number = EXCLUDED.gid_number,
          synced_at = now()
    RETURNING id, provider, name, description, gid_number
  `;
  if (!row) return { ok: false, error: "Failed to persist IPA group mirror", status: 500 };

  return {
    ok: true,
    data: {
      id: row.id as string,
      provider: row.provider as "ipa" | "local",
      name: row.name as string,
      description: row.description as string | null,
      gidnumber: row.gid_number as number | null,
      personalOwner: null,
    },
  };
};

export const update = async (params: { ipaSession: string; id: string; description: string }): Promise<MutationResult<void>> => {
  const unavailable = await ensureFreeIpaMutationAvailable();
  if (unavailable) return unavailable;
  const group = await getIpaGroupById(params.id);
  if (!group) return { ok: false, error: "IPA group not found", status: 404 };

  const response = await freeipa.client.call({
    url: await getIpaUrl(),
    ipaSession: params.ipaSession,
    method: "group_mod",
    args: [group.cn],
    options: { description: params.description },
  });
  if (response.error) return ipaMutationError(response);

  await sql`UPDATE auth.groups SET description = ${params.description}, synced_at = now() WHERE id = ${group.id}`;
  return { ok: true, data: undefined };
};

export const del = async (params: { ipaSession: string; id: string }): Promise<MutationResult<void>> => {
  const unavailable = await ensureFreeIpaMutationAvailable();
  if (unavailable) return unavailable;
  const group = await getIpaGroupById(params.id);
  if (!group) return { ok: false, error: "IPA group not found", status: 404 };

  const response = await freeipa.client.call({
    url: await getIpaUrl(),
    ipaSession: params.ipaSession,
    method: "group_del",
    args: [group.cn],
    options: {},
  });
  if (response.error) return ipaMutationError(response);

  await sql`DELETE FROM auth.groups WHERE id = ${group.id}`;
  return { ok: true, data: undefined };
};

export const makePosix = async (params: { ipaSession: string; id: string }): Promise<MutationResult<{ gidnumber: number | null }>> => {
  const unavailable = await ensureFreeIpaMutationAvailable();
  if (unavailable) return unavailable;
  const group = await getIpaGroupById(params.id);
  if (!group) return { ok: false, error: "IPA group not found", status: 404 };

  const response = await freeipa.client.call({
    url: await getIpaUrl(),
    ipaSession: params.ipaSession,
    method: "group_mod",
    args: [group.cn],
    options: { posix: true },
  });
  if (response.error) return ipaMutationError(response);

  const gidnumber = freeipa.util.num((response.result?.result as Record<string, unknown> | undefined)?.gidnumber);
  await sql`UPDATE auth.groups SET gid_number = ${gidnumber}, synced_at = now() WHERE id = ${group.id}`;
  return { ok: true, data: { gidnumber } };
};

export const addMember = async (params: {
  ipaSession: string;
  id: string;
  user?: string;
  group?: string;
}): Promise<MutationResult<void>> => {
  const unavailable = await ensureFreeIpaMutationAvailable();
  if (unavailable) return unavailable;
  const group = await getIpaGroupById(params.id);
  if (!group) return { ok: false, error: "IPA group not found", status: 404 };

  let userUid: string | undefined;
  if (params.user) {
    const [userRow] = await sql<DbRow[]>`SELECT uid FROM auth.users WHERE id = ${params.user} AND provider = 'ipa'`;
    if (!userRow) return { ok: false, error: "IPA user not found", status: 404 };
    const [existing] = await sql<DbRow[]>`
      SELECT 1
      FROM auth.user_groups_v2
      WHERE user_id = ${params.user}::uuid
        AND group_id = ${group.id}::uuid
      LIMIT 1
    `;
    if (existing) return { ok: false, error: "User is already a direct member of this group", status: 409 };
    userUid = userRow.uid as string;
  }

  let childGroup: IpaGroupRow | null = null;
  if (params.group) {
    childGroup = await getIpaGroupById(params.group);
    if (!childGroup) return { ok: false, error: "IPA group not found", status: 404 };
    const [existing] = await sql<DbRow[]>`
      SELECT 1
      FROM auth.group_groups_v2
      WHERE parent_group_id = ${group.id}::uuid
        AND child_group_id = ${childGroup.id}::uuid
      LIMIT 1
    `;
    if (existing) return { ok: false, error: "Group is already a direct member of this group", status: 409 };
  }

  const options: Record<string, unknown> = {};
  if (userUid) options.user = userUid;
  if (childGroup) options.group = childGroup.cn;

  const response = await freeipa.client.call({
    url: await getIpaUrl(),
    ipaSession: params.ipaSession,
    method: "group_add_member",
    args: [group.cn],
    options,
  });
  if (response.error) return ipaMutationError(response);

  const result = response.result?.result as Record<string, unknown> | undefined;
  const memberFailed = (result?.failed as Record<string, unknown> | undefined)?.member as Record<string, unknown> | undefined;
  if (userUid && Array.isArray(memberFailed?.user) && memberFailed.user.length > 0) {
    return { ok: false, error: (memberFailed.user[0] as [string, string])[1] || "Failed to add user to group", status: 400 };
  }
  if (childGroup && Array.isArray(memberFailed?.group) && memberFailed.group.length > 0) {
    return { ok: false, error: (memberFailed.group[0] as [string, string])[1] || "Failed to add group to group", status: 400 };
  }

  if (params.user) {
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${params.user}, ${group.id}) ON CONFLICT DO NOTHING`;
    await updateUserIpaProfile(params.user);
  }
  if (childGroup) {
    await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${group.id}, ${childGroup.id}) ON CONFLICT DO NOTHING`;
    await updateProfileForAffectedUsers(childGroup.id);
  }

  return { ok: true, data: undefined };
};

export const removeMember = async (params: {
  ipaSession: string;
  id: string;
  user?: string;
  group?: string;
}): Promise<MutationResult<void>> => {
  const unavailable = await ensureFreeIpaMutationAvailable();
  if (unavailable) return unavailable;
  const group = await getIpaGroupById(params.id);
  if (!group) return { ok: false, error: "IPA group not found", status: 404 };

  let userUid: string | undefined;
  if (params.user) {
    const [userRow] = await sql<DbRow[]>`SELECT uid FROM auth.users WHERE id = ${params.user} AND provider = 'ipa'`;
    if (!userRow) return { ok: false, error: "IPA user not found", status: 404 };
    userUid = userRow.uid as string;
  }

  let childGroup: IpaGroupRow | null = null;
  if (params.group) {
    childGroup = await getIpaGroupById(params.group);
    if (!childGroup) return { ok: false, error: "IPA group not found", status: 404 };
  }

  const options: Record<string, unknown> = {};
  if (userUid) options.user = userUid;
  if (childGroup) options.group = childGroup.cn;

  const response = await freeipa.client.call({
    url: await getIpaUrl(),
    ipaSession: params.ipaSession,
    method: "group_remove_member",
    args: [group.cn],
    options,
  });
  if (response.error) return ipaMutationError(response);

  const result = response.result?.result as Record<string, unknown> | undefined;
  const memberFailed = (result?.failed as Record<string, unknown> | undefined)?.member as Record<string, unknown> | undefined;
  if (userUid && Array.isArray(memberFailed?.user) && memberFailed.user.length > 0) {
    return { ok: false, error: (memberFailed.user[0] as [string, string])[1] || "Failed to remove user from group", status: 400 };
  }
  if (childGroup && Array.isArray(memberFailed?.group) && memberFailed.group.length > 0) {
    return { ok: false, error: (memberFailed.group[0] as [string, string])[1] || "Failed to remove group from group", status: 400 };
  }

  if (params.user) {
    await sql`DELETE FROM auth.user_groups_v2 WHERE user_id = ${params.user} AND group_id = ${group.id}`;
    await updateUserIpaProfile(params.user);
  }
  if (childGroup) {
    const affectedUsers = await sql<DbRow[]>`
      WITH RECURSIVE child_groups AS (
        SELECT ${childGroup.id}::uuid AS group_id
        UNION
        SELECT gg.child_group_id
        FROM auth.group_groups_v2 gg
        JOIN child_groups cg ON gg.parent_group_id = cg.group_id
      )
      SELECT DISTINCT ug.user_id
      FROM auth.user_groups_v2 ug
      JOIN child_groups cg ON ug.group_id = cg.group_id
    `;

    await sql`DELETE FROM auth.group_groups_v2 WHERE parent_group_id = ${group.id} AND child_group_id = ${childGroup.id}`;
    for (const row of affectedUsers) {
      await updateUserIpaProfile(row.user_id as string);
    }
  }

  return { ok: true, data: undefined };
};

export const addManager = async (params: {
  ipaSession: string;
  id: string;
  user?: string;
  group?: string;
}): Promise<MutationResult<void>> => {
  const unavailable = await ensureFreeIpaMutationAvailable();
  if (unavailable) return unavailable;
  const group = await getIpaGroupById(params.id);
  if (!group) return { ok: false, error: "IPA group not found", status: 404 };

  let userUid: string | undefined;
  if (params.user) {
    const [userRow] = await sql<DbRow[]>`SELECT uid FROM auth.users WHERE id = ${params.user} AND provider = 'ipa'`;
    if (!userRow) return { ok: false, error: "IPA user not found", status: 404 };
    const [existing] = await sql<DbRow[]>`
      SELECT 1
      FROM auth.group_manager_users_v2
      WHERE group_id = ${group.id}::uuid
        AND user_id = ${params.user}::uuid
      LIMIT 1
    `;
    if (existing) return { ok: false, error: "User is already a direct manager of this group", status: 409 };
    userUid = userRow.uid as string;
  }

  let managerGroup: IpaGroupRow | null = null;
  if (params.group) {
    managerGroup = await getIpaGroupById(params.group);
    if (!managerGroup) return { ok: false, error: "IPA group not found", status: 404 };
    const [existing] = await sql<DbRow[]>`
      SELECT 1
      FROM auth.group_manager_groups_v2
      WHERE group_id = ${group.id}::uuid
        AND manager_group_id = ${managerGroup.id}::uuid
      LIMIT 1
    `;
    if (existing) return { ok: false, error: "Group is already a direct manager of this group", status: 409 };
  }

  const options: Record<string, unknown> = {};
  if (userUid) options.user = userUid;
  if (managerGroup) options.group = managerGroup.cn;

  const response = await freeipa.client.call({
    url: await getIpaUrl(),
    ipaSession: params.ipaSession,
    method: "group_add_member_manager",
    args: [group.cn],
    options,
  });
  if (response.error) return ipaMutationError(response);

  const result = response.result?.result as Record<string, unknown> | undefined;
  const managerFailed = (result?.failed as Record<string, unknown> | undefined)?.membermanager as Record<string, unknown> | undefined;
  if (userUid && Array.isArray(managerFailed?.user) && managerFailed.user.length > 0) {
    return { ok: false, error: (managerFailed.user[0] as [string, string])[1] || "Failed to add user as manager", status: 400 };
  }
  if (managerGroup && Array.isArray(managerFailed?.group) && managerFailed.group.length > 0) {
    return { ok: false, error: (managerFailed.group[0] as [string, string])[1] || "Failed to add group as manager", status: 400 };
  }

  if (params.user) {
    await sql`INSERT INTO auth.group_manager_users_v2 (group_id, user_id) VALUES (${group.id}, ${params.user}) ON CONFLICT DO NOTHING`;
  }
  if (managerGroup) {
    await sql`INSERT INTO auth.group_manager_groups_v2 (group_id, manager_group_id) VALUES (${group.id}, ${managerGroup.id}) ON CONFLICT DO NOTHING`;
  }

  return { ok: true, data: undefined };
};

export const removeManager = async (params: {
  ipaSession: string;
  id: string;
  user?: string;
  group?: string;
}): Promise<MutationResult<void>> => {
  const unavailable = await ensureFreeIpaMutationAvailable();
  if (unavailable) return unavailable;
  const group = await getIpaGroupById(params.id);
  if (!group) return { ok: false, error: "IPA group not found", status: 404 };

  let userUid: string | undefined;
  if (params.user) {
    const [userRow] = await sql<DbRow[]>`SELECT uid FROM auth.users WHERE id = ${params.user} AND provider = 'ipa'`;
    if (!userRow) return { ok: false, error: "IPA user not found", status: 404 };
    userUid = userRow.uid as string;
  }

  let managerGroup: IpaGroupRow | null = null;
  if (params.group) {
    managerGroup = await getIpaGroupById(params.group);
    if (!managerGroup) return { ok: false, error: "IPA group not found", status: 404 };
  }

  const options: Record<string, unknown> = {};
  if (userUid) options.user = userUid;
  if (managerGroup) options.group = managerGroup.cn;

  const response = await freeipa.client.call({
    url: await getIpaUrl(),
    ipaSession: params.ipaSession,
    method: "group_remove_member_manager",
    args: [group.cn],
    options,
  });
  if (response.error) return ipaMutationError(response);

  const result = response.result?.result as Record<string, unknown> | undefined;
  const managerFailed = (result?.failed as Record<string, unknown> | undefined)?.membermanager as Record<string, unknown> | undefined;
  if (userUid && Array.isArray(managerFailed?.user) && managerFailed.user.length > 0) {
    return { ok: false, error: (managerFailed.user[0] as [string, string])[1] || "Failed to remove user as manager", status: 400 };
  }
  if (managerGroup && Array.isArray(managerFailed?.group) && managerFailed.group.length > 0) {
    return { ok: false, error: (managerFailed.group[0] as [string, string])[1] || "Failed to remove group as manager", status: 400 };
  }

  if (params.user) {
    await sql`DELETE FROM auth.group_manager_users_v2 WHERE group_id = ${group.id} AND user_id = ${params.user}`;
  }
  if (managerGroup) {
    await sql`DELETE FROM auth.group_manager_groups_v2 WHERE group_id = ${group.id} AND manager_group_id = ${managerGroup.id}`;
  }

  return { ok: true, data: undefined };
};

export const getManagedGroupsByName = async (params: { id: string }): Promise<string[]> => {
  const ids = await getManagedGroups(params);
  if (ids.length === 0) return [];
  const rows = await sql<DbRow[]>`SELECT name FROM auth.groups WHERE id = ANY(${toPgUuidArray(ids)}::uuid[]) ORDER BY name`;
  return rows.map((row) => row.name as string);
};
