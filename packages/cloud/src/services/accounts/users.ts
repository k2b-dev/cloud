import { type SQL, sql } from "bun";
import type { BaseUser, MutationResult, PaginationResponse, Role, User, UserProfile, UserProvider } from "../../contracts/shared";
import { freeipa } from "../../server/services";
import { createAuthLoginUrl } from "../../shared/redirect";
import { isAccountCategoryAllowed } from "../account-category-policy";
import type { AuditActor } from "../audit";
import { getFreeIpaConfig } from "../freeipa-config";
import { getServiceIpaSession } from "../ipa/service-account";
import { toPgTextArray, toPgUuidArray } from "../postgres";
import { providers } from "../providers";
import { session } from "../session";
import * as settings from "../settings";
import { buildRoles } from "./authz";
import { buildBaseUser, resolveProviderProfile } from "./base-user";
import { managedGroupIdsSubquery, managedGroupsNamesSubquery, recursiveGroupIdsSubquery, recursiveGroupNamesSubquery } from "./group-sql";
import { buildIpaUserData, emptyIpaUserData, userIpaDataColumns, userIpaDataJoin } from "./ipa-data";
import {
  canPersistStoredAdmin,
  getDefaultAccountExpiry,
  parseManualAccountExpiry,
  resolveAccountExpires,
  resolveEffectiveAdminState,
  resolveTargetAccountExpiry,
} from "./model";
import type { AccountsNotificationSender } from "./notification-sender";
import { transitionIpaUserToLocal } from "./switching";

export { clearAvatar, getAvatar, parseAvatarDataUrl, setAvatar } from "./avatar";

type DbRow = Record<string, unknown>;
type UserMutationTarget = BaseUser & { accountExpires: string | null; storedAdmin: boolean };

type CreateUserData = {
  provider: UserProvider;
  profile: UserProfile;
  admin?: boolean;
  email: string;
  givenname: string;
  sn: string;
  displayName?: string;
  autoSendNotification?: boolean;
  requestId?: string;
  accountExpires?: string | null;
};

type UpdateUserData = {
  givenname?: string;
  sn?: string;
  displayName?: string;
  mail?: string;
  ipa?: {
    phone?: string;
    address?: {
      street?: string;
      postalCode?: string;
      city?: string;
      state?: string;
    };
    sshPublicKeys?: string[];
  };
};

const buildUserMutationTarget = (row: DbRow): UserMutationTarget => ({
  ...buildBaseUser(row),
  accountExpires: resolveAccountExpires(row)?.toISOString() ?? null,
  storedAdmin: Boolean(row.admin),
});

const pgArrayLiteralToStrings = (value: string): string[] => {
  if (value === "{}") return [];
  if (!value.startsWith("{") || !value.endsWith("}")) return [];
  const items: string[] = [];
  let item = "";
  let quoted = false;
  let escaped = false;
  let wasQuoted = false;

  for (const char of value.slice(1, -1)) {
    if (escaped) {
      item += char;
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      wasQuoted = true;
      continue;
    }
    if (!quoted && char === ",") {
      if (wasQuoted || (item !== "" && item !== "NULL")) items.push(item);
      item = "";
      wasQuoted = false;
      continue;
    }
    item += char;
  }

  if (wasQuoted || (item !== "" && item !== "NULL")) items.push(item);
  return items;
};

const stringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return pgArrayLiteralToStrings(value);
  return [];
};

const buildUser = (row: DbRow, groupsAdmin: string[]): User => {
  const { provider, profile } = resolveProviderProfile(row);
  const displayName = (row.display_name as string) ?? "";
  const mail = (row.mail as string) ?? null;
  const memberofGroup = stringArray(row.member_groups);
  const memberofGroupIds = stringArray(row.member_group_ids);
  const manages = stringArray(row.manages);
  const managesGroupIds = stringArray(row.manages_group_ids);
  const effectiveAdmin =
    row.effective_admin !== undefined
      ? Boolean(row.effective_admin)
      : resolveEffectiveAdminState({
          provider,
          storedAdmin: Boolean(row.admin),
          memberofGroup,
          groupsAdmin,
        });
  const roles = buildRoles({
    provider,
    profile,
    memberofGroup,
    manages,
    admin: effectiveAdmin,
  });
  const common = {
    id: row.id as string,
    uid: row.uid as string,
    roles,
    profile,
    givenname: (row.given_name as string) ?? "",
    sn: (row.sn as string) ?? "",
    displayName: displayName || (profile === "guest" && mail ? mail : ""),
    mail,
    avatarHash: (row.avatar_hash as string | null | undefined) ?? null,
    accountExpires: resolveAccountExpires(row)?.toISOString() ?? null,
    lastLoginLocal: row.last_login_local ? (row.last_login_local as Date).toISOString() : null,
    memberofGroup,
    memberofGroupIds,
    manages,
    managesGroupIds,
  };

  if (provider === "ipa") {
    return {
      ...common,
      provider: "ipa",
      ipa: buildIpaUserData(row) ?? emptyIpaUserData(),
    };
  }

  return {
    ...common,
    provider: "local",
    ipa: null,
  };
};

export const get = async (params: { id: string } | { uid: string }): Promise<User | null> => {
  const whereClause = "id" in params ? sql`u.id = ${params.id}` : sql`u.uid = ${params.uid}`;
  const userIdExpr = "id" in params ? sql`${params.id}` : sql`u.id`;
  const { groupsAdmin } = await getFreeIpaConfig();
  const rows = await sql<DbRow[]>`
    SELECT u.*,
      ${userIpaDataColumns},
      CASE
        WHEN u.provider = 'local' THEN u.admin
        ELSE EXISTS(
          SELECT 1
          FROM auth.ipa_user_effective_groups eg
          WHERE eg.user_id = u.id
            AND eg.group_name = ANY(${toPgTextArray(groupsAdmin)}::text[])
        )
      END AS effective_admin,
      COALESCE(ARRAY(
        SELECT g.name
        FROM auth.user_groups_v2 ug
        JOIN auth.groups g ON g.id = ug.group_id
        WHERE ug.user_id = u.id
        ORDER BY g.name
      ), '{}') AS member_groups,
      COALESCE(ARRAY(
        SELECT ug.group_id
        FROM auth.user_groups_v2 ug
        JOIN auth.groups g ON g.id = ug.group_id
        WHERE ug.user_id = u.id
        ORDER BY g.name
      ), '{}') AS member_group_ids,
      COALESCE(ARRAY(
        ${managedGroupsNamesSubquery(userIdExpr)}
      ), '{}') AS manages,
      COALESCE(ARRAY(
        ${managedGroupIdsSubquery(userIdExpr)}
      ), '{}') AS manages_group_ids
    FROM auth.users u
    ${userIpaDataJoin}
    WHERE ${whereClause}
  `;
  if (rows.length === 0) return null;
  return buildUser(rows[0]!, groupsAdmin);
};

export const getMinimal = async (params: { id: string } | { uid: string }): Promise<UserMutationTarget | null> => {
  const whereClause = "id" in params ? sql`id = ${params.id}` : sql`uid = ${params.uid}`;
  const rows = await sql<DbRow[]>`
    SELECT id, uid, provider, profile, admin, given_name, sn, display_name, mail, avatar_hash, account_expires
    FROM auth.users
    WHERE ${whereClause}
  `;
  if (rows.length === 0) return null;
  return buildUserMutationTarget(rows[0]!);
};

export const getByUid = async (params: { uid: string }): Promise<{ id: string; roles: Role[] } | null> => {
  const { groupsAdmin } = await getFreeIpaConfig();
  const rows = await sql<DbRow[]>`
    SELECT u.id, u.provider, u.profile, u.admin,
      CASE
        WHEN u.provider = 'local' THEN u.admin
        ELSE EXISTS(
          SELECT 1
          FROM auth.ipa_user_effective_groups eg
          WHERE eg.user_id = u.id
            AND eg.group_name = ANY(${toPgTextArray(groupsAdmin)}::text[])
        )
      END AS effective_admin
    FROM auth.users u
    WHERE u.uid = ${params.uid}
  `;
  if (rows.length === 0) return null;
  const { provider, profile } = resolveProviderProfile(rows[0]!);
  const roles = buildRoles({
    provider,
    profile,
    memberofGroup: [],
    manages: [],
    admin: Boolean(rows[0]!.effective_admin),
  });
  return { id: rows[0]!.id as string, roles };
};

export const list = async (params: {
  ids?: string[];
  uids?: string[];
  search?: string;
  provider?: UserProvider;
  profile?: UserProfile;
  page?: number;
  perPage?: number;
}) => {
  const page = params.page ?? 1;
  const perPage = params.perPage ?? 100;
  const offset = (page - 1) * perPage;
  const search = params.search ? `%${freeipa.util.escapeLike(params.search.toLowerCase())}%` : null;
  const ids = params.ids;
  const uids = params.uids;

  if ((ids && ids.length === 0) || (uids && uids.length === 0)) {
    return {
      users: [],
      total: 0,
      pagination: {
        page,
        per_page: perPage,
        total: 0,
        total_pages: 0,
        has_next: false,
      } satisfies PaginationResponse,
    };
  }

  const conditions: SQL.Query<unknown>[] = [sql`TRUE`];
  if (ids) conditions.push(sql`id = ANY(${toPgUuidArray(ids)}::uuid[])`);
  if (uids) conditions.push(sql`uid = ANY(${toPgTextArray(uids)}::text[])`);
  if (params.provider) conditions.push(sql`provider = ${params.provider}`);
  if (params.profile) conditions.push(sql`profile = ${params.profile}`);
  if (search) {
    conditions.push(sql`(
      LOWER(uid) LIKE ${search} ESCAPE '\\' OR
      LOWER(display_name) LIKE ${search} ESCAPE '\\' OR
      LOWER(given_name) LIKE ${search} ESCAPE '\\' OR
      LOWER(sn) LIKE ${search} ESCAPE '\\' OR
      LOWER(mail) LIKE ${search} ESCAPE '\\'
    )`);
  }

  const where = conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);
  const countRows = await sql<DbRow[]>`SELECT COUNT(*)::int AS count FROM auth.users WHERE ${where}`;
  const total = (countRows[0]?.count as number) ?? 0;
  const totalPages = Math.ceil(total / perPage);
  const groupsAdmin = (await getFreeIpaConfig()).groupsAdmin;
  const rows = await sql<DbRow[]>`
    SELECT u.*,
      CASE
        WHEN u.provider = 'local' THEN u.admin
        ELSE EXISTS(
          SELECT 1
          FROM auth.ipa_user_effective_groups eg
          WHERE eg.user_id = u.id
            AND eg.group_name = ANY(${toPgTextArray(groupsAdmin)}::text[])
        )
      END AS effective_admin
    FROM auth.users u
    WHERE ${where}
    ORDER BY uid
    LIMIT ${perPage} OFFSET ${offset}
  `;

  return {
    users: rows.map(buildBaseUser),
    total,
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
    } satisfies PaginationResponse,
  };
};

export const getGroups = async (params: { id: string; recursive?: boolean }): Promise<string[]> => {
  if (params.recursive) {
    const rows = await sql<DbRow[]>`${recursiveGroupNamesSubquery(params.id)}`;
    return rows.map((row) => row.name as string);
  }

  const rows = await sql<DbRow[]>`
    SELECT g.name
    FROM auth.user_groups_v2 ug
    JOIN auth.groups g ON g.id = ug.group_id
    WHERE ug.user_id = ${params.id}::uuid
    ORDER BY g.name
  `;
  return rows.map((row) => row.name as string);
};

export const getGroupIds = async (params: { id: string; recursive?: boolean }): Promise<string[]> => {
  if (params.recursive) {
    const rows = await sql<DbRow[]>`${recursiveGroupIdsSubquery(params.id)}`;
    return rows.map((row) => row.group_id as string);
  }

  const rows = await sql<DbRow[]>`
    SELECT ug.group_id
    FROM auth.user_groups_v2 ug
    JOIN auth.groups g ON g.id = ug.group_id
    WHERE ug.user_id = ${params.id}::uuid
    ORDER BY g.name
  `;
  return rows.map((row) => row.group_id as string);
};

export const getManagedGroups = async (params: { id: string; recursive?: boolean }): Promise<string[]> => {
  if (params.recursive === false) {
    const rows = await sql<DbRow[]>`
      SELECT DISTINCT g.name
      FROM auth.groups g
      LEFT JOIN auth.group_manager_users_v2 gmu ON gmu.group_id = g.id AND gmu.user_id = ${params.id}::uuid
      LEFT JOIN auth.group_manager_groups_v2 gmg ON gmg.group_id = g.id
      LEFT JOIN auth.user_groups_v2 ug ON ug.group_id = gmg.manager_group_id AND ug.user_id = ${params.id}::uuid
      LEFT JOIN auth.groups g_manager ON g_manager.id = gmg.manager_group_id
      WHERE gmu.user_id IS NOT NULL OR (ug.user_id IS NOT NULL AND g_manager.provider = g.provider)
      ORDER BY g.name
    `;
    return rows.map((row) => row.name as string);
  }

  const rows = await sql<DbRow[]>`${managedGroupsNamesSubquery(params.id)}`;
  return rows.map((row) => row.name as string);
};

/**
 * Same as `getManagedGroups` but returns group IDs. Prefer this for
 * authorization checks — group names are unique only per provider, so
 * comparing by name can authorize a local group based on a same-named
 * IPA group membership (or vice versa).
 */
export const getManagedGroupIds = async (params: { id: string; recursive?: boolean }): Promise<string[]> => {
  if (params.recursive === false) {
    const rows = await sql<DbRow[]>`
      SELECT DISTINCT g.id
      FROM auth.groups g
      LEFT JOIN auth.group_manager_users_v2 gmu ON gmu.group_id = g.id AND gmu.user_id = ${params.id}::uuid
      LEFT JOIN auth.group_manager_groups_v2 gmg ON gmg.group_id = g.id
      LEFT JOIN auth.user_groups_v2 ug ON ug.group_id = gmg.manager_group_id AND ug.user_id = ${params.id}::uuid
      LEFT JOIN auth.groups g_manager ON g_manager.id = gmg.manager_group_id
      WHERE gmu.user_id IS NOT NULL OR (ug.user_id IS NOT NULL AND g_manager.provider = g.provider)
      ORDER BY g.id
    `;
    return rows.map((row) => row.id as string);
  }

  const rows = await sql<DbRow[]>`${managedGroupIdsSubquery(params.id)}`;
  return rows.map((row) => row.id as string);
};

export const demoteToGuest = async (params: { id: string; actor: { userId: string; uid: string } }): Promise<MutationResult<void>> => {
  const user = await getMinimal({ id: params.id });
  if (!user) return { ok: false, error: "User not found", status: 404 };
  if (user.provider !== "ipa") {
    return { ok: false, error: "Only IPA-backed accounts can be demoted to local guests", status: 400 };
  }
  const serviceSession = await getServiceIpaSession();
  if (!serviceSession.ok) return serviceSession;

  return providers.ipa.users.demoteToGuest({
    ipaSession: serviceSession.data,
    id: params.id,
    actor: params.actor,
  });
};

export const create = async (params: {
  data: CreateUserData;
  actor?: AuditActor;
}): Promise<MutationResult<{ user: User; temporaryPassword?: string }>> => {
  if (!(await isAccountCategoryAllowed(params.data)))
    return { ok: false, error: "This account category is disabled. Contact an administrator.", status: 403 };
  if (params.data.provider === "local" && params.data.admin && !canPersistStoredAdmin("local", params.data.profile)) {
    return { ok: false, error: "Only local full accounts can be created as admins", status: 400 };
  }

  const accountExpires = await resolveTargetAccountExpiry({
    provider: params.data.provider,
    profile: params.data.profile,
    requested: params.data.accountExpires,
  });

  if (params.data.provider === "local") {
    const created = await providers.local.users.create({
      actor: params.actor,
      data: {
        email: params.data.email,
        givenname: params.data.givenname,
        sn: params.data.sn,
        displayName: params.data.displayName,
      },
      profile: params.data.profile,
      accountExpires,
      admin: params.data.admin,
    });
    if (!created.ok) return created;
    const user = await get({ id: created.data.id });
    if (!user) return { ok: false, error: "Created user not found", status: 500 };
    return { ok: true, data: { user } };
  }

  const serviceSession = await getServiceIpaSession();
  if (!serviceSession.ok) return serviceSession;

  const created = await providers.ipa.users.create({
    ipaSession: serviceSession.data,
    profile: params.data.profile,
    accountExpires,
    data: {
      email: params.data.email,
      givenname: params.data.givenname,
      sn: params.data.sn,
      displayName: params.data.displayName,
      autoSendNotification: params.data.autoSendNotification,
      requestId: params.data.requestId,
    },
  });
  if (!created.ok) return created;
  const user = await get({ id: created.data.id });
  if (!user) return { ok: false, error: "Created user not found", status: 500 };
  return {
    ok: true,
    data: {
      user,
      temporaryPassword: created.data._temporaryPassword,
    },
  };
};

export const update = async (params: { id: string; data: UpdateUserData }): Promise<MutationResult<void>> => {
  const user = await getMinimal({ id: params.id });
  if (!user) return { ok: false, error: "User not found", status: 404 };

  if (user.provider === "ipa") {
    const serviceSession = await getServiceIpaSession();
    if (!serviceSession.ok) return serviceSession;
    return providers.ipa.users.update({
      ipaSession: serviceSession.data,
      id: params.id,
      data: params.data,
    });
  }

  if (params.data.ipa) {
    return { ok: false, error: "IPA-only fields can only be updated for IPA-backed users", status: 400 };
  }

  return providers.local.users.update({
    id: params.id,
    data: params.data,
  });
};

export const setProfile = async (params: { id: string; profile: UserProfile; actor?: AuditActor }): Promise<MutationResult<void>> => {
  const user = await getMinimal({ id: params.id });
  if (!user) return { ok: false, error: "User not found", status: 404 };
  if (user.provider !== "local") {
    return { ok: false, error: "IPA profile is derived from IPA groups and cannot be set directly", status: 400 };
  }

  const accountExpires = user.accountExpires ? new Date(user.accountExpires) : await getDefaultAccountExpiry("local", params.profile);
  return providers.local.users.setProfile({
    actor: params.actor,
    id: params.id,
    profile: params.profile,
    accountExpires,
  });
};

export const setAdmin = async (params: { id: string; admin: boolean }): Promise<MutationResult<void>> => {
  const user = await getMinimal({ id: params.id });
  if (!user) return { ok: false, error: "User not found", status: 404 };
  if (!canPersistStoredAdmin(user.provider, user.profile)) {
    return {
      ok: false,
      error:
        user.provider === "ipa"
          ? "FreeIPA admin access is managed through FreeIPA groups"
          : "Guest accounts cannot be granted admin access",
      status: 400,
    };
  }

  return providers.local.users.setAdmin(params);
};

export const setExpiry = async (params: {
  actor?: { userId: string; uid: string; roles: string[] };
  id: string;
  expiryDate: string | null;
}): Promise<MutationResult<void>> => {
  const user = await getMinimal({ id: params.id });
  if (!user) return { ok: false, error: "User not found", status: 404 };

  const selfTarget = params.actor?.userId === params.id;
  if (selfTarget && !params.actor?.roles.includes("admin")) {
    return { ok: false, error: "Only admins can change their own account expiry.", status: 403 };
  }

  // Explicit account-expiry management is allowed to target the acting admin
  // as well. Automatic self-extension remains handled separately by the
  // account-lifecycle service and must not turn non-expiring accounts back into
  // expiring ones implicitly.
  if (user.provider === "ipa") {
    const serviceSession = await getServiceIpaSession();
    if (!serviceSession.ok) return serviceSession;
    return providers.ipa.users.setExpiry({
      ipaSession: serviceSession.data,
      id: params.id,
      expiryDate: params.expiryDate,
    });
  }

  const parsed = parseManualAccountExpiry(params.expiryDate);
  if (!parsed.ok) return { ok: false, error: parsed.error, status: 400 };

  return providers.local.users.setExpiry({
    id: params.id,
    profile: user.profile,
    accountExpires: parsed.date,
  });
};

export const sendLoginLink = async (params: {
  id: string;
  notificationSender: AccountsNotificationSender;
  locale?: string;
}): Promise<MutationResult<void>> => {
  const user = await getMinimal({ id: params.id });
  if (!user) return { ok: false, error: "User not found", status: 404 };
  if (user.provider !== "local") {
    return { ok: false, error: "Login links are only available for local accounts", status: 400 };
  }
  if (!user.mail) return { ok: false, error: "A local account requires an email address to receive a login link", status: 400 };

  const token = await providers.local.auth.createMagicLinkToken({ email: user.mail, ttlSeconds: 300 });
  const rawAppUrl = await settings.get<string>("app.url");
  const appUrl = rawAppUrl.startsWith("http") ? rawAppUrl : `https://${rawAppUrl}`;
  try {
    const delivery = await params.notificationSender.sendLoginLink({
      email: user.mail,
      token,
      magicLink: createAuthLoginUrl(appUrl, { token }),
      locale: params.locale,
    });
    if (delivery.status !== "error" && delivery.status !== "suppressed") return { ok: true, data: undefined };
  } catch {
    // Keep the service contract result-based even when rendering or persistence fails.
  }
  return { ok: false, error: "The login link could not be delivered", status: 500 };
};

export const createLoginToken = async (params: {
  id: string;
}): Promise<MutationResult<{ token: string; magicLink: string; expiresInSeconds: number }>> => {
  const user = await getMinimal({ id: params.id });
  if (!user) return { ok: false, error: "User not found", status: 404 };
  if (user.provider !== "local") {
    return { ok: false, error: "Login tokens are only available for local accounts", status: 400 };
  }
  if (!user.mail) {
    return { ok: false, error: "A local account requires an email address before a login token can be created", status: 400 };
  }

  const expiresInSeconds = 300;
  const token = await providers.local.auth.createMagicLinkToken({
    email: user.mail,
    ttlSeconds: expiresInSeconds,
  });
  const rawAppUrl = await settings.get<string>("app.url");
  const appUrl = rawAppUrl.startsWith("http") ? rawAppUrl : `https://${rawAppUrl}`;

  return {
    ok: true,
    data: {
      token,
      magicLink: createAuthLoginUrl(appUrl, { token }),
      expiresInSeconds,
    },
  };
};

export const resetPassword = async (params: { id: string }): Promise<MutationResult<{ password: string }>> => {
  const user = await getMinimal({ id: params.id });
  if (!user) return { ok: false, error: "User not found", status: 404 };
  if (user.provider !== "ipa") {
    return { ok: false, error: "Password resets are only available for IPA-backed accounts", status: 400 };
  }
  const serviceSession = await getServiceIpaSession();
  if (!serviceSession.ok) return serviceSession;

  return providers.ipa.users.resetPassword({
    ipaSession: serviceSession.data,
    id: params.id,
  });
};

export const switchProvider = async (params: { id: string; provider: UserProvider }): Promise<MutationResult<void>> => {
  const user = await getMinimal({ id: params.id });
  if (!user) return { ok: false, error: "User not found", status: 404 };
  const freeIpaConfig = await getFreeIpaConfig();

  const currentProvider = user.provider;
  const currentProfile = user.profile;
  const currentExpiry = user.accountExpires ? new Date(user.accountExpires) : null;

  if (currentProvider === params.provider) {
    return { ok: false, error: `Account already uses provider '${params.provider}'`, status: 400 };
  }

  if (!freeIpaConfig.enabled) {
    return { ok: false, error: "FreeIPA is disabled.", status: 400 };
  }

  const serviceSession = await getServiceIpaSession();
  if (!serviceSession.ok) return serviceSession;

  if (params.provider === "ipa") {
    if (!user.mail) {
      return { ok: false, error: "A local account needs an email address before it can be switched to IPA", status: 400 };
    }

    const result = await providers.ipa.users.create({
      ipaSession: serviceSession.data,
      profile: currentProfile,
      accountExpires: currentExpiry,
      data: {
        email: user.mail,
        givenname: user.givenname,
        sn: user.sn,
        displayName: user.displayName || undefined,
        autoSendNotification: false,
      },
    });
    if (!result.ok) return result;
    return { ok: true, data: undefined };
  }

  const response = await freeipa.client.call({
    url: freeIpaConfig.url,
    ipaSession: serviceSession.data,
    method: "user_del",
    args: [user.uid],
    options: {},
  });
  const ipaDeleteMessage = (response.error?.message ?? "").toLowerCase();
  const ipaDeleteNotFound = ipaDeleteMessage.includes("not found") || ipaDeleteMessage.includes("does not exist");
  if (response.error && !ipaDeleteNotFound) {
    return {
      ok: false,
      error: response.error.message ?? "Failed to delete user from FreeIPA",
      status: freeipa.util.mapIpaErrorCode(response.error.code),
    };
  }

  await sql.begin(async (tx) => {
    await transitionIpaUserToLocal({
      userId: params.id,
      targetProfile: currentProfile,
      accountExpires: currentExpiry,
      db: tx,
    });
  });

  await session.revokeAllForUser(params.id);

  return { ok: true, data: undefined };
};

export const remove = async (params: { id: string; actor: { userId: string; uid: string } }): Promise<MutationResult<void>> => {
  const user = await getMinimal({ id: params.id });
  if (!user) return { ok: false, error: "User not found", status: 404 };

  if (user.provider === "ipa") {
    const serviceSession = await getServiceIpaSession();
    if (!serviceSession.ok) return serviceSession;
    return providers.ipa.users.remove({
      ipaSession: serviceSession.data,
      id: params.id,
      actor: params.actor,
    });
  }

  return providers.local.users.remove({
    id: params.id,
    actor: params.actor,
  });
};
