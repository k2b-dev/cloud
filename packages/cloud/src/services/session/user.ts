import type { SQLQuery } from "bun";
import type { User } from "../../contracts/shared";
import { sql } from "../../runtime/clients";
import { decodeAccountCategoryEnabled } from "../account-category-policy";
import { accountLockedSql } from "../account-lock";
import { buildRoles } from "../accounts/authz";
import { resolveProviderProfile } from "../accounts/base-user";
import { managedGroupIdsSubquery } from "../accounts/group-sql";
import { buildIpaUserData, emptyIpaUserData, userIpaDataColumns, userIpaDataJoin } from "../accounts/ipa-data";
import { resolveAccountExpires } from "../accounts/model";
import { toPgTextArray } from "../postgres";
import { setRailCacheVersion } from "../rail-snapshot";
import { sharedWorkstationIdleSeconds } from "./shared-workstation";

type DbRow = Record<string, unknown>;

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
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
      wasQuoted = true;
    } else if (char === "," && !quoted) {
      if (wasQuoted || (item !== "" && item !== "NULL")) items.push(item);
      item = "";
      wasQuoted = false;
    } else {
      item += char;
    }
  }
  if (wasQuoted || (item !== "" && item !== "NULL")) items.push(item);
  return items;
};

const stringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return pgArrayLiteralToStrings(value);
  return [];
};

/** The user as the mobile app's session sees it: never an installation administrator. */
export const withoutAdminRole = (user: User): User => ({ ...user, roles: user.roles.filter((role) => role !== "admin") });

export const buildProjectedUser = (row: DbRow): User => {
  const { provider, profile } = resolveProviderProfile(row);
  const mail = (row.mail as string | null | undefined) ?? null;
  const displayName = (row.display_name as string | null | undefined) ?? "";
  const memberofGroup = stringArray(row.member_groups);
  const memberofGroupIds = stringArray(row.member_group_ids);
  const manages = stringArray(row.manages);
  const managesGroupIds = stringArray(row.manages_group_ids);
  const common = {
    id: row.id as string,
    uid: row.uid as string,
    // An app session of the mobile app never acts as an installation administrator.
    roles: buildRoles({ provider, profile, memberofGroup, manages, admin: Boolean(row.effective_admin) && !row.pwa_device_id }),
    profile,
    givenname: (row.given_name as string | null | undefined) ?? "",
    sn: (row.sn as string | null | undefined) ?? "",
    displayName: displayName || (profile === "guest" && mail ? mail : ""),
    mail,
    avatarHash: (row.avatar_hash as string | null | undefined) ?? null,
    accountExpires: resolveAccountExpires(row)?.toISOString() ?? null,
    lastLoginLocal: row.last_login_local ? new Date(row.last_login_local as Date | string).toISOString() : null,
    memberofGroup,
    memberofGroupIds,
    manages,
    managesGroupIds,
  };
  const user: User =
    provider === "ipa"
      ? { ...common, provider: "ipa", ipa: buildIpaUserData(row) ?? emptyIpaUserData() }
      : { ...common, provider: "local", ipa: null };
  setRailCacheVersion(user, row.rail_cache_version);
  return user;
};

export const userProjectionSql = (groupsAdmin: string[]) => sql`
  u.*,
  (SELECT cache_version::text FROM auth.rail_state WHERE singleton) || ':' ||
    COALESCE((SELECT cache_version::text FROM auth.rail_preferences WHERE user_id = u.id), 'default') AS rail_cache_version,
  ${userIpaDataColumns()},
  CASE
    WHEN u.provider = 'local' THEN u.admin
    ELSE EXISTS(
      SELECT 1 FROM auth.ipa_user_effective_groups eg
      WHERE eg.user_id = u.id
        AND eg.group_name = ANY(${toPgTextArray(groupsAdmin)}::text[])
    )
  END AS effective_admin,
  membership.member_groups, membership.member_group_ids,
  management.manages, management.manages_group_ids
`;

/** One scan for membership names/IDs and one recursive traversal for management. */
export const userProjectionJoin = () => sql`
  ${userIpaDataJoin()}
  LEFT JOIN LATERAL (
    SELECT COALESCE(array_agg(g.name ORDER BY g.name), '{}') AS member_groups,
      COALESCE(array_agg(g.id ORDER BY g.name), '{}') AS member_group_ids
    FROM auth.user_groups_v2 ug JOIN auth.groups g ON g.id = ug.group_id
    WHERE ug.user_id = u.id
  ) membership ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(array_agg(DISTINCT g.name ORDER BY g.name), '{}') AS manages,
      COALESCE(array_agg(g.id ORDER BY g.name), '{}') AS manages_group_ids
    FROM auth.groups g WHERE g.id IN (${managedGroupIdsSubquery(sql`u.id`)})
  ) management ON true
`;

type SessionUserParams = {
  userId: string;
  sid: string;
  authEpoch: number;
  /** Core's consent screen only: still validates family, epoch and expiry. */
  allowPendingLegalConsent?: boolean;
};

/** A browser session on a shared workstation: seconds left until it ends without input, and the administrator's limit. */
export type SessionIdle = { remainingSeconds: number; timeoutSeconds: number };

/**
 * Ends a shared-workstation family whose last real input lies beyond the idle limit. The condition repeats inside the
 * update, so an input recorded meanwhile keeps the session, and a family revoked meanwhile stays ended. True when the
 * family is ended.
 */
const endIdleFamily = async (sid: string, timeoutSeconds: number, query: typeof sql): Promise<boolean> => {
  const [ended] = await query<Array<{ sid: string }>>`
    UPDATE auth.session_families
    SET revoked_at = COALESCE(revoked_at, now()), revocation_reason = COALESCE(revocation_reason, 'idle')
    WHERE sid = ${sid}::uuid
      AND (revoked_at IS NOT NULL OR last_input_at <= now() - ${timeoutSeconds} * interval '1 second')
    RETURNING sid
  `;
  return Boolean(ended);
};

/** The idle state of a loaded row; null when the family has no idle limit. Ends the family once its limit passed. */
const checkIdle = async (
  row: DbRow,
  sid: string,
  query: typeof sql,
): Promise<{ ended: true } | { ended: false; idle: SessionIdle | null }> => {
  if (row.idle_seconds === null || row.idle_seconds === undefined) return { ended: false, idle: null };
  const timeoutSeconds = await sharedWorkstationIdleSeconds();
  const idleSeconds = Math.max(0, Number(row.idle_seconds));
  if (idleSeconds >= timeoutSeconds && (await endIdleFamily(sid, timeoutSeconds, query))) return { ended: true };
  return { ended: false, idle: { remainingSeconds: Math.max(0, Math.floor(timeoutSeconds - idleSeconds)), timeoutSeconds } };
};

// Both projections use the same live validity checks. Neither caches authorization.
const loadSessionRow = async (
  params: SessionUserParams,
  projection: SQLQuery,
  join: SQLQuery,
  query: typeof sql,
): Promise<{ row: DbRow; idle: SessionIdle | null } | null> => {
  const [row] = await query<DbRow[]>`
    SELECT ${projection}, sf.pwa_device_id AS pwa_device_id,
      EXTRACT(EPOCH FROM now() - sf.last_input_at)::float8 AS idle_seconds, (
      SELECT value FROM settings.entries WHERE key = 'user.category.' ||
        CASE WHEN u.provider = 'ipa' THEN 'freeipa' WHEN u.profile = 'guest' THEN 'guest' ELSE 'login' END || '.enabled'
    ) AS category_enabled
    FROM auth.session_families sf
    JOIN auth.users u ON u.id = sf.user_id
    JOIN auth.signing_keys sk ON sk.kid = sf.signing_kid AND sk.state <> 'revoked'
    ${join}
    WHERE sf.sid = ${params.sid}::uuid
      AND sf.user_id = ${params.userId}::uuid
      AND sf.auth_epoch = ${params.authEpoch}
      AND u.auth_epoch = ${params.authEpoch}
      AND sf.revoked_at IS NULL
      AND sf.expires_at > now()
      AND NOT ${accountLockedSql(sql`u.id`)}
      AND (${params.allowPendingLegalConsent === true} OR NOT sf.legal_pending OR EXISTS (
        SELECT 1 FROM auth.legal_acceptances la WHERE la.user_id = u.id
      ))
  `;
  if (!row || !(await decodeAccountCategoryEnabled(row.category_enabled))) return null;
  const idle = await checkIdle(row, params.sid, query);
  return idle.ended ? null : { row, idle: idle.idle };
};

/** The user of a valid session family and, for an app session of the mobile app, its device. */
export const loadJwtSession = async (
  params: SessionUserParams & { groupsAdmin: string[] },
  query: typeof sql = sql,
): Promise<{ user: User; pwaDeviceId: string | null; idle: SessionIdle | null } | null> => {
  const loaded = await loadSessionRow(params, userProjectionSql(params.groupsAdmin), userProjectionJoin(), query);
  return loaded
    ? {
        user: buildProjectedUser(loaded.row),
        pwaDeviceId: loaded.row.pwa_device_id ? String(loaded.row.pwa_device_id) : null,
        idle: loaded.idle,
      }
    : null;
};

export const loadJwtSessionUser = async (
  params: SessionUserParams & { groupsAdmin: string[] },
  query: typeof sql = sql,
): Promise<User | null> => (await loadJwtSession(params, query))?.user ?? null;

/** Identity-only consumers must not pay for group, IPA, role and rail projections. */
export const loadJwtSessionIdentity = async (params: SessionUserParams, query: typeof sql = sql) => {
  const loaded = await loadSessionRow(params, sql`u.id, u.account_expires`, sql``, query);
  return loaded ? { userId: String(loaded.row.id), accountExpires: resolveAccountExpires(loaded.row)?.toISOString() ?? null } : null;
};

export const loadCurrentUser = async (params: { userId: string; groupsAdmin: string[] }, query: typeof sql = sql): Promise<User | null> => {
  const rows = await query<DbRow[]>`
    SELECT ${userProjectionSql(params.groupsAdmin)}
    FROM auth.users u
    ${userProjectionJoin()}
    WHERE u.id = ${params.userId}::uuid
  `;
  return rows[0] ? buildProjectedUser(rows[0]) : null;
};
