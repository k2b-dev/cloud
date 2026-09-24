import { sql } from "bun";
import type { BaseGroup, GroupMember, MutationResult, UserProvider } from "../../contracts/shared";
import { freeipa } from "../../server/services";
import { getServiceIpaSession } from "../ipa/service-account";
import { toPgUuidArray } from "../postgres";
import { providers } from "../providers";
import type { AccountsActor } from "./authz";
import { buildBaseGroup, personalOwnerJoin } from "./base-group";
import { buildManagedGroupScopeCondition, buildMemberGroupScopeCondition } from "./group-sql";
import * as localGroups from "./local-groups";
import { posix } from "./posix";

type DbRow = Record<string, unknown>;

type GroupListScope = "all" | "member" | "managed";

const getGroup = async (id: string): Promise<BaseGroup | null> => {
  const [row] = await sql<DbRow[]>`
    SELECT g.id, g.provider, g.name, g.description, g.gid_number, personal_owner.*
    FROM auth.groups g
    ${personalOwnerJoin()}
    WHERE g.id = ${id}::uuid
  `;
  if (!row) return null;
  return buildBaseGroup(row);
};

const listCanonical = async (params: {
  ids?: string[];
  userId?: string;
  scope?: GroupListScope;
  search?: string;
  provider?: UserProvider;
  /** Personal Linux groups are left out of browsing and search unless requested; an explicit `ids` lookup always returns them. */
  includePersonal?: boolean;
  page?: number;
  perPage?: number;
}): Promise<{
  groups: BaseGroup[];
  total: number;
  pagination: { page: number; perPage: number; totalPages: number; hasNext: boolean };
}> => {
  const page = params.page ?? 1;
  const perPage = params.perPage ?? 100;
  const offset = (page - 1) * perPage;
  const pattern = params.search ? `%${freeipa.util.escapeLike(params.search.toLowerCase())}%` : null;
  const ids = params.ids ?? [];
  const scope = params.scope ?? (params.userId ? "member" : "all");
  const scopeUserId = params.userId ?? "00000000-0000-0000-0000-000000000000";
  const idsCondition = ids.length === 0 ? sql`TRUE` : sql`g.id = ANY(${toPgUuidArray(ids)}::uuid[])`;
  const includePersonal = params.includePersonal === true || params.ids !== undefined;

  if (params.ids && params.ids.length === 0) {
    return {
      groups: [],
      total: 0,
      pagination: {
        page,
        perPage,
        totalPages: 0,
        hasNext: false,
      },
    };
  }

  const rows = await sql<DbRow[]>`
    SELECT g.id, g.provider, g.name, g.description, g.gid_number, personal_owner.*, COUNT(*) OVER() AS total
    FROM auth.groups g
    ${personalOwnerJoin()}
    WHERE (${params.provider ?? null}::text IS NULL OR g.provider = ${params.provider ?? null})
      AND ${idsCondition}
      AND (${includePersonal} = true OR personal_owner.personal_owner_id IS NULL)
      AND (
        ${scope === "all"} = true
        OR ${params.userId ?? null}::uuid IS NULL
        OR (${scope === "member"} = true AND ${buildMemberGroupScopeCondition({ userId: scopeUserId, groupProvider: sql`g.provider` })})
        OR (${scope === "managed"} = true AND ${buildManagedGroupScopeCondition({ userId: scopeUserId, groupProvider: sql`g.provider` })})
      )
      AND (
        ${pattern}::text IS NULL
        OR LOWER(g.name) LIKE ${pattern} ESCAPE '\\'
        OR LOWER(COALESCE(g.description, '')) LIKE ${pattern} ESCAPE '\\'
      )
    ORDER BY g.name
    LIMIT ${perPage}
    OFFSET ${offset}
  `;

  const total = rows.length > 0 ? Number((rows[0] as Record<string, unknown>).total) : 0;
  return {
    groups: rows.map(buildBaseGroup),
    total,
    pagination: {
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
      hasNext: page * perPage < total,
    },
  };
};

export const list = async (params: {
  ids?: string[];
  userId?: string;
  scope?: GroupListScope;
  search?: string;
  provider?: UserProvider;
  /** Personal Linux groups are left out of browsing and search unless requested; an explicit `ids` lookup always returns them. */
  includePersonal?: boolean;
  page?: number;
  perPage?: number;
}) => {
  return listCanonical(params);
};

export const get = async (params: { id: string }): Promise<BaseGroup | null> => {
  return getGroup(params.id);
};

export const getMembers = async (params: {
  id: string;
  provider?: UserProvider;
  type?: "user" | "group";
  recursive?: boolean;
}): Promise<GroupMember[]> => {
  const provider = params.provider ?? (await getGroup(params.id))?.provider;
  if (provider === "local") return localGroups.getMembers(params);
  if (!provider) return [];
  return providers.ipa.groups.getMembers(params);
};

export const getManagers = async (params: {
  id: string;
  provider?: UserProvider;
  type?: "user" | "group";
  recursive?: boolean;
}): Promise<GroupMember[]> => {
  const provider = params.provider ?? (await getGroup(params.id))?.provider;
  if (provider === "local") return localGroups.getManagers(params);
  if (!provider) return [];
  return providers.ipa.groups.getManagers(params);
};

export const getParents = async (params: { id: string; provider?: UserProvider; recursive?: boolean }): Promise<string[]> => {
  const provider = params.provider ?? (await getGroup(params.id))?.provider;
  if (provider === "local") return localGroups.getParents(params);
  if (!provider) return [];
  return providers.ipa.groups.getParents(params);
};

export const getManagedGroups = async (params: { id: string; provider?: UserProvider }): Promise<string[]> => {
  const provider = params.provider ?? (await getGroup(params.id))?.provider;
  if (provider === "local") return localGroups.getManagedGroups(params);
  if (!provider) return [];
  return providers.ipa.groups.getManagedGroups(params);
};

export const create = async (params: {
  actor: AccountsActor;
  provider: UserProvider;
  name: string;
  description?: string;
  posix?: boolean;
}): Promise<MutationResult<BaseGroup>> => {
  if (params.provider === "local") {
    if (params.posix) return { ok: true, data: await posix.createGroup({ id: params.actor.userId, roles: params.actor.roles }, params) };
    return localGroups.create({ name: params.name, description: params.description });
  }
  const serviceSession = await getServiceIpaSession();
  if (!serviceSession.ok) return serviceSession;
  return providers.ipa.groups.add({
    ipaSession: serviceSession.data,
    cn: params.name,
    description: params.description,
    posix: params.posix,
  });
};

export const update = async (params: { id: string; provider?: UserProvider; description: string }): Promise<MutationResult<void>> => {
  const provider = params.provider ?? (await getGroup(params.id))?.provider;
  if (provider === "local") return localGroups.update({ id: params.id, description: params.description });
  const serviceSession = await getServiceIpaSession();
  if (!serviceSession.ok) return serviceSession;
  return providers.ipa.groups.update({
    ipaSession: serviceSession.data,
    id: params.id,
    description: params.description,
  });
};

export const remove = async (params: { id: string; provider?: UserProvider }): Promise<MutationResult<void>> => {
  const provider = params.provider ?? (await getGroup(params.id))?.provider;
  if (provider === "local") return localGroups.remove({ id: params.id });
  const serviceSession = await getServiceIpaSession();
  if (!serviceSession.ok) return serviceSession;
  return providers.ipa.groups.remove({
    ipaSession: serviceSession.data,
    id: params.id,
  });
};

export const makePosix = async (params: {
  actor: AccountsActor;
  id: string;
  provider?: UserProvider;
}): Promise<MutationResult<{ gidnumber: number | null }>> => {
  const provider = (await getGroup(params.id))?.provider;
  if (!provider) return { ok: false, error: "Group not found", status: 404 };
  if (provider === "local") {
    const result = await posix.provisionGroup({ id: params.actor.userId, roles: params.actor.roles }, params.id);
    return { ok: true, data: { gidnumber: result.gidNumber } };
  }
  const serviceSession = await getServiceIpaSession();
  if (!serviceSession.ok) return serviceSession;
  return providers.ipa.groups.makePosix({
    ipaSession: serviceSession.data,
    id: params.id,
  });
};

export const addMember = async (params: {
  id: string;
  provider?: UserProvider;
  user?: string;
  group?: string;
}): Promise<MutationResult<void>> => {
  const provider = params.provider ?? (await getGroup(params.id))?.provider;
  if (provider === "local") return localGroups.addMember({ id: params.id, user: params.user, group: params.group });
  const serviceSession = await getServiceIpaSession();
  if (!serviceSession.ok) return serviceSession;
  return providers.ipa.groups.addMember({
    ipaSession: serviceSession.data,
    id: params.id,
    user: params.user,
    group: params.group,
  });
};

export const removeMember = async (params: {
  id: string;
  provider?: UserProvider;
  user?: string;
  group?: string;
}): Promise<MutationResult<void>> => {
  const provider = params.provider ?? (await getGroup(params.id))?.provider;
  if (provider === "local") return localGroups.removeMember({ id: params.id, user: params.user, group: params.group });
  const serviceSession = await getServiceIpaSession();
  if (!serviceSession.ok) return serviceSession;
  return providers.ipa.groups.removeMember({
    ipaSession: serviceSession.data,
    id: params.id,
    user: params.user,
    group: params.group,
  });
};

export const addManager = async (params: {
  id: string;
  provider?: UserProvider;
  user?: string;
  group?: string;
}): Promise<MutationResult<void>> => {
  const provider = params.provider ?? (await getGroup(params.id))?.provider;
  if (provider === "local") return localGroups.addManager({ id: params.id, user: params.user, group: params.group });
  const serviceSession = await getServiceIpaSession();
  if (!serviceSession.ok) return serviceSession;
  return providers.ipa.groups.addManager({
    ipaSession: serviceSession.data,
    id: params.id,
    user: params.user,
    group: params.group,
  });
};

export const removeManager = async (params: {
  id: string;
  provider?: UserProvider;
  user?: string;
  group?: string;
}): Promise<MutationResult<void>> => {
  const provider = params.provider ?? (await getGroup(params.id))?.provider;
  if (provider === "local") return localGroups.removeManager({ id: params.id, user: params.user, group: params.group });
  const serviceSession = await getServiceIpaSession();
  if (!serviceSession.ok) return serviceSession;
  return providers.ipa.groups.removeManager({
    ipaSession: serviceSession.data,
    id: params.id,
    user: params.user,
    group: params.group,
  });
};
