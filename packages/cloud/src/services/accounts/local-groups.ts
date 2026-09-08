import { sql } from "bun";
import type { BaseGroup, GroupMember, MutationResult, UserProvider } from "../../contracts/shared";
import { escapeLikePattern, isUniqueViolation } from "../postgres";

type DbRow = Record<string, unknown>;

type LocalGroupRow = {
  id: string;
  provider: "local";
  name: string;
  description: string | null;
  gidNumber: number | null;
};

const toBaseGroup = (row: LocalGroupRow): BaseGroup => ({
  id: row.id,
  provider: row.provider,
  name: row.name,
  description: row.description,
  gidnumber: row.gidNumber,
});

const getLocalGroupById = async (id: string): Promise<LocalGroupRow | null> => {
  const [row] = await sql<DbRow[]>`
    SELECT id, provider, name, description, gid_number
    FROM auth.groups
    WHERE id = ${id}::uuid AND provider = 'local'
  `;
  if (!row) return null;
  return {
    id: row.id as string,
    provider: row.provider as "local",
    name: row.name as string,
    description: row.description as string | null,
    gidNumber: row.gid_number as number | null,
  };
};

const getUserProvider = async (userId: string): Promise<UserProvider | null> => {
  const [row] = await sql<DbRow[]>`SELECT provider FROM auth.users WHERE id = ${userId}`;
  return (row?.provider as UserProvider | undefined) ?? null;
};

const ensureLocalGroupTreeMember = async (groupId: string): Promise<boolean> => {
  const [row] = await sql<DbRow[]>`SELECT 1 FROM auth.groups WHERE id = ${groupId} AND provider = 'local'`;
  return Boolean(row);
};

const wouldCreateLocalGroupCycle = async (params: { parentGroupId: string; childGroupId: string }): Promise<boolean> => {
  if (params.parentGroupId === params.childGroupId) return true;

  const [row] = await sql<DbRow[]>`
    WITH RECURSIVE descendants AS (
      SELECT gg.child_group_id
      FROM auth.group_groups_v2 gg
      JOIN auth.groups g ON g.id = gg.child_group_id
      WHERE gg.parent_group_id = ${params.childGroupId}::uuid
        AND g.provider = 'local'
      UNION
      SELECT gg.child_group_id
      FROM auth.group_groups_v2 gg
      JOIN auth.groups g ON g.id = gg.child_group_id
      JOIN descendants d ON d.child_group_id = gg.parent_group_id
      WHERE g.provider = 'local'
    )
    SELECT 1
    FROM descendants
    WHERE child_group_id = ${params.parentGroupId}::uuid
    LIMIT 1
  `;

  return Boolean(row);
};

export const get = async (params: { id: string }): Promise<BaseGroup | null> => {
  const row = await getLocalGroupById(params.id);
  return row ? toBaseGroup(row) : null;
};

export const create = async (params: { name: string; description?: string }): Promise<MutationResult<BaseGroup>> => {
  const storedCn = `local:${params.name}`;
  try {
    const rows = await sql<DbRow[]>`
      INSERT INTO auth.groups (id, cn, provider, name, description, synced_at)
      VALUES (gen_random_uuid(), ${storedCn}, 'local', ${params.name}, ${params.description ?? null}, now())
      RETURNING id, provider, name, description, gid_number
    `;

    return {
      ok: true,
      data: toBaseGroup({
        id: rows[0]!.id as string,
        provider: "local",
        name: rows[0]!.name as string,
        description: rows[0]!.description as string | null,
        gidNumber: rows[0]!.gid_number as number | null,
      }),
    };
  } catch (error) {
    if (isUniqueViolation(error, "groups_cn_key") || isUniqueViolation(error, "groups_provider_name_unique")) {
      return { ok: false, error: "A local group with this name already exists.", status: 409 };
    }
    throw error;
  }
};

export const list = async (params: { page?: number; perPage?: number; search?: string }) => {
  const page = params.page ?? 1;
  const perPage = params.perPage ?? 100;
  const offset = (page - 1) * perPage;
  const search = params.search?.trim().toLowerCase();
  const pattern = search ? `%${escapeLikePattern(search)}%` : null;

  const [countRow] = await sql<DbRow[]>`
    SELECT COUNT(*)::int AS count
    FROM auth.groups g
    WHERE g.provider = 'local'
      AND (${pattern}::text IS NULL OR LOWER(g.name) LIKE ${pattern} ESCAPE '\\' OR LOWER(g.description) LIKE ${pattern} ESCAPE '\\')
  `;
  const total = Number(countRow?.count ?? 0);
  const rows = await sql<DbRow[]>`
    SELECT id, provider, name, description, gid_number
    FROM auth.groups g
    WHERE g.provider = 'local'
      AND (${pattern}::text IS NULL OR LOWER(g.name) LIKE ${pattern} ESCAPE '\\' OR LOWER(g.description) LIKE ${pattern} ESCAPE '\\')
    ORDER BY g.name
    LIMIT ${perPage} OFFSET ${offset}
  `;

  return {
    groups: rows.map((row) =>
      toBaseGroup({
        id: row.id as string,
        provider: row.provider as "local",
        name: row.name as string,
        description: row.description as string | null,
        gidNumber: row.gid_number as number | null,
      }),
    ),
    total,
    pagination: {
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
      hasNext: page * perPage < total,
    },
  };
};

export const update = async (params: { id: string; description: string }): Promise<MutationResult<void>> => {
  const group = await getLocalGroupById(params.id);
  if (!group) return { ok: false, error: "Group not found", status: 404 };

  await sql`
    UPDATE auth.groups
    SET description = ${params.description}
    WHERE id = ${params.id}::uuid
      AND provider = 'local'
  `;
  return { ok: true, data: undefined };
};

export const remove = async (params: { id: string }): Promise<MutationResult<void>> => {
  const group = await getLocalGroupById(params.id);
  if (!group) return { ok: false, error: "Group not found", status: 404 };

  const [primary] = await sql`SELECT 1 FROM auth.user_posix WHERE primary_group_id = ${params.id}::uuid LIMIT 1`;
  if (primary) return { ok: false, error: "This group is a user's primary Linux group and cannot be deleted.", status: 409 };
  try {
    await sql`DELETE FROM auth.groups WHERE id = ${params.id}::uuid AND provider = 'local'`;
  } catch (error) {
    if (error && typeof error === "object" && "errno" in error && error.errno === "23503") {
      return { ok: false, error: "This group is still used by a Linux identity.", status: 409 };
    }
    throw error;
  }
  return { ok: true, data: undefined };
};

export const getMembers = async (params: { id: string; type?: "user" | "group"; recursive?: boolean }): Promise<GroupMember[]> => {
  const group = await getLocalGroupById(params.id);
  if (!group) return [];
  const members: GroupMember[] = [];

  if (!params.type || params.type === "user") {
    const userRows = params.recursive
      ? await sql<DbRow[]>`
          WITH RECURSIVE local_group_tree AS (
            SELECT ${group.id}::uuid AS group_id
            UNION
            SELECT gg.child_group_id
            FROM auth.group_groups_v2 gg
            JOIN auth.groups g ON g.id = gg.child_group_id
            JOIN local_group_tree tree ON tree.group_id = gg.parent_group_id
            WHERE g.provider = 'local'
          )
          SELECT DISTINCT u.id, u.uid, u.display_name
          FROM local_group_tree tree
          JOIN auth.user_groups_v2 ug ON ug.group_id = tree.group_id
          JOIN auth.users u ON u.id = ug.user_id
          ORDER BY u.uid
        `
      : await sql<DbRow[]>`
          SELECT u.id, u.uid, u.display_name
          FROM auth.user_groups_v2 ug
          JOIN auth.users u ON u.id = ug.user_id
          WHERE ug.group_id = ${group.id}
          ORDER BY u.uid
        `;
    for (const row of userRows) {
      members.push({ type: "user", id: row.id as string, displayName: (row.display_name as string | null) ?? (row.uid as string) });
    }
  }

  if (!params.type || params.type === "group") {
    const groupRows = params.recursive
      ? await sql<DbRow[]>`
          WITH RECURSIVE local_group_tree AS (
            SELECT gg.child_group_id
            FROM auth.group_groups_v2 gg
            JOIN auth.groups g ON g.id = gg.child_group_id
            WHERE gg.parent_group_id = ${group.id}::uuid
              AND g.provider = 'local'
            UNION
            SELECT gg.child_group_id
            FROM auth.group_groups_v2 gg
            JOIN auth.groups g ON g.id = gg.child_group_id
            JOIN local_group_tree tree ON tree.child_group_id = gg.parent_group_id
            WHERE g.provider = 'local'
          )
          SELECT DISTINCT g.id, g.name
          FROM local_group_tree tree
          JOIN auth.groups g ON g.id = tree.child_group_id
          ORDER BY g.name
        `
      : await sql<DbRow[]>`
          SELECT g.id, g.name
          FROM auth.group_groups_v2 gg
          JOIN auth.groups g ON g.id = gg.child_group_id
          WHERE gg.parent_group_id = ${group.id} AND g.provider = 'local'
          ORDER BY g.name
        `;
    for (const row of groupRows) {
      members.push({ type: "group", id: row.id as string, displayName: row.name as string });
    }
  }

  return members;
};

export const getManagers = async (params: { id: string; type?: "user" | "group"; recursive?: boolean }): Promise<GroupMember[]> => {
  const group = await getLocalGroupById(params.id);
  if (!group) return [];

  const managers: GroupMember[] = [];

  if (!params.type || params.type === "user") {
    // Match IPA semantics (see ipa/groups.ts getManagers): start from the
    // target's *direct manager groups*, then walk UPWARDS via parent
    // relations, then collect members of every group in that set plus direct
    // user managers of the target. The previous implementation walked DOWN
    // the target's *child* tree and treated their managers as managers of the
    // parent, which over-broadens authorization (a manager of a sub-team
    // would inherit rights on the parent team).
    const userRows = params.recursive
      ? await sql<DbRow[]>`
          WITH RECURSIVE manager_groups AS (
            SELECT gmg.manager_group_id AS group_id
            FROM auth.group_manager_groups_v2 gmg
            JOIN auth.groups g_manager ON g_manager.id = gmg.manager_group_id
            WHERE gmg.group_id = ${group.id} AND g_manager.provider = 'local'
            UNION
            SELECT gg.parent_group_id AS group_id
            FROM auth.group_groups_v2 gg
            JOIN auth.groups g_parent ON g_parent.id = gg.parent_group_id
            JOIN manager_groups mg ON gg.child_group_id = mg.group_id
            WHERE g_parent.provider = 'local'
          )
          SELECT DISTINCT u.id, u.uid, u.display_name
          FROM (
            SELECT gmu.user_id
            FROM auth.group_manager_users_v2 gmu
            WHERE gmu.group_id = ${group.id}
            UNION
            SELECT ug.user_id
            FROM auth.user_groups_v2 ug
            JOIN manager_groups mg ON ug.group_id = mg.group_id
          ) all_managers
          JOIN auth.users u ON u.id = all_managers.user_id
          ORDER BY u.uid
        `
      : await sql<DbRow[]>`
          SELECT u.id, u.uid, u.display_name
          FROM auth.group_manager_users_v2 gmu
          JOIN auth.users u ON u.id = gmu.user_id
          WHERE gmu.group_id = ${group.id}
          ORDER BY u.uid
        `;
    for (const row of userRows) {
      managers.push({ type: "user", id: row.id as string, displayName: (row.display_name as string | null) ?? (row.uid as string) });
    }
  }

  if (!params.type || params.type === "group") {
    // Direct manager groups only. Parents of manager groups are managers-by-transitivity
    // at the user level (handled above), but we don't conflate them into "group managers"
    // of the target — that would misrepresent the configured relations.
    const groupRows = await sql<DbRow[]>`
      SELECT g.id, g.name
      FROM auth.group_manager_groups_v2 gmg
      JOIN auth.groups g ON g.id = gmg.manager_group_id
      WHERE gmg.group_id = ${group.id} AND g.provider = 'local'
      ORDER BY g.name
    `;
    for (const row of groupRows) {
      managers.push({ type: "group", id: row.id as string, displayName: row.name as string });
    }
  }

  return managers;
};

export const getParents = async (params: { id: string; recursive?: boolean }): Promise<string[]> => {
  const group = await getLocalGroupById(params.id);
  if (!group) return [];

  const rows = params.recursive
    ? await sql<DbRow[]>`
        WITH RECURSIVE local_parent_tree AS (
          SELECT gg.parent_group_id
          FROM auth.group_groups_v2 gg
          JOIN auth.groups g ON g.id = gg.parent_group_id
          WHERE gg.child_group_id = ${group.id}::uuid
            AND g.provider = 'local'
          UNION
          SELECT gg.parent_group_id
          FROM auth.group_groups_v2 gg
          JOIN auth.groups g ON g.id = gg.parent_group_id
          JOIN local_parent_tree tree ON tree.parent_group_id = gg.child_group_id
          WHERE g.provider = 'local'
        )
        SELECT DISTINCT parent_group_id
        FROM local_parent_tree
      `
    : await sql<DbRow[]>`
        SELECT gg.parent_group_id
        FROM auth.group_groups_v2 gg
        JOIN auth.groups g ON g.id = gg.parent_group_id
        WHERE gg.child_group_id = ${group.id}
          AND g.provider = 'local'
        ORDER BY g.name
      `;

  return rows.map((row) => row.parent_group_id as string);
};

export const getManagedGroups = async (params: { id: string; recursive?: boolean }): Promise<string[]> => {
  const group = await getLocalGroupById(params.id);
  if (!group) return [];

  const rows = params.recursive
    ? await sql<DbRow[]>`
        WITH RECURSIVE local_manager_tree AS (
          SELECT ${group.id}::uuid AS manager_group_id
          UNION
          SELECT gg.child_group_id
          FROM auth.group_groups_v2 gg
          JOIN auth.groups g ON g.id = gg.child_group_id
          JOIN local_manager_tree tree ON tree.manager_group_id = gg.parent_group_id
          WHERE g.provider = 'local'
        )
        SELECT DISTINCT gmg.group_id
        FROM local_manager_tree tree
        JOIN auth.group_manager_groups_v2 gmg ON gmg.manager_group_id = tree.manager_group_id
        JOIN auth.groups g ON g.id = gmg.group_id
        WHERE g.provider = 'local'
      `
    : await sql<DbRow[]>`
        SELECT gmg.group_id
        FROM auth.group_manager_groups_v2 gmg
        JOIN auth.groups g ON g.id = gmg.group_id
        WHERE gmg.manager_group_id = ${group.id}
          AND g.provider = 'local'
        ORDER BY g.name
      `;

  return rows.map((row) => row.group_id as string);
};

export const addMember = async (params: { id: string; user?: string; group?: string }): Promise<MutationResult<void>> => {
  const group = await getLocalGroupById(params.id);
  if (!group) return { ok: false, error: "Group not found", status: 404 };

  if (params.user) {
    const provider = await getUserProvider(params.user);
    if (!provider) return { ok: false, error: "User not found", status: 404 };
    const [existing] = await sql<DbRow[]>`
      SELECT 1
      FROM auth.user_groups_v2
      WHERE user_id = ${params.user}::uuid
        AND group_id = ${group.id}::uuid
      LIMIT 1
    `;
    if (existing) return { ok: false, error: "User is already a direct member of this group", status: 409 };
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${params.user}, ${group.id}) ON CONFLICT DO NOTHING`;
    return { ok: true, data: undefined };
  }

  if (params.group) {
    const isLocal = await ensureLocalGroupTreeMember(params.group);
    if (!isLocal) return { ok: false, error: "Only local groups can be nested into local groups", status: 400 };
    const [existing] = await sql<DbRow[]>`
      SELECT 1
      FROM auth.group_groups_v2
      WHERE parent_group_id = ${group.id}::uuid
        AND child_group_id = ${params.group}::uuid
      LIMIT 1
    `;
    if (existing) return { ok: false, error: "Group is already a direct member of this group", status: 409 };
    if (await wouldCreateLocalGroupCycle({ parentGroupId: group.id, childGroupId: params.group })) {
      return { ok: false, error: "Local group nesting cannot create cycles", status: 400 };
    }
    await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${group.id}, ${params.group}) ON CONFLICT DO NOTHING`;
    return { ok: true, data: undefined };
  }

  return { ok: false, error: "Missing member", status: 400 };
};

export const removeMember = async (params: { id: string; user?: string; group?: string }): Promise<MutationResult<void>> => {
  const group = await getLocalGroupById(params.id);
  if (!group) return { ok: false, error: "Group not found", status: 404 };

  if (params.user) {
    await sql`DELETE FROM auth.user_groups_v2 WHERE user_id = ${params.user}::uuid AND group_id = ${group.id}::uuid`;
    return { ok: true, data: undefined };
  }

  if (params.group) {
    await sql`DELETE FROM auth.group_groups_v2 WHERE parent_group_id = ${group.id}::uuid AND child_group_id = ${params.group}::uuid`;
    return { ok: true, data: undefined };
  }

  return { ok: false, error: "Missing member", status: 400 };
};

export const addManager = async (params: { id: string; user?: string; group?: string }): Promise<MutationResult<void>> => {
  const group = await getLocalGroupById(params.id);
  if (!group) return { ok: false, error: "Group not found", status: 404 };

  if (params.user) {
    const provider = await getUserProvider(params.user);
    if (!provider) return { ok: false, error: "User not found", status: 404 };
    const [existing] = await sql<DbRow[]>`
      SELECT 1
      FROM auth.group_manager_users_v2
      WHERE group_id = ${group.id}::uuid
        AND user_id = ${params.user}::uuid
      LIMIT 1
    `;
    if (existing) return { ok: false, error: "User is already a direct manager of this group", status: 409 };
    await sql`INSERT INTO auth.group_manager_users_v2 (group_id, user_id) VALUES (${group.id}, ${params.user}) ON CONFLICT DO NOTHING`;
    return { ok: true, data: undefined };
  }

  if (params.group) {
    const isLocal = await ensureLocalGroupTreeMember(params.group);
    if (!isLocal) return { ok: false, error: "Only local groups can manage local groups", status: 400 };
    const [existing] = await sql<DbRow[]>`
      SELECT 1
      FROM auth.group_manager_groups_v2
      WHERE group_id = ${group.id}::uuid
        AND manager_group_id = ${params.group}::uuid
      LIMIT 1
    `;
    if (existing) return { ok: false, error: "Group is already a direct manager of this group", status: 409 };
    await sql`INSERT INTO auth.group_manager_groups_v2 (group_id, manager_group_id) VALUES (${group.id}, ${params.group}) ON CONFLICT DO NOTHING`;
    return { ok: true, data: undefined };
  }

  return { ok: false, error: "Missing manager", status: 400 };
};

export const removeManager = async (params: { id: string; user?: string; group?: string }): Promise<MutationResult<void>> => {
  const group = await getLocalGroupById(params.id);
  if (!group) return { ok: false, error: "Group not found", status: 404 };

  if (params.user) {
    await sql`DELETE FROM auth.group_manager_users_v2 WHERE group_id = ${group.id}::uuid AND user_id = ${params.user}::uuid`;
    return { ok: true, data: undefined };
  }

  if (params.group) {
    await sql`DELETE FROM auth.group_manager_groups_v2 WHERE group_id = ${group.id}::uuid AND manager_group_id = ${params.group}::uuid`;
    return { ok: true, data: undefined };
  }

  return { ok: false, error: "Missing manager", status: 400 };
};
