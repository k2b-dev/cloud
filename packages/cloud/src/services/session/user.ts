import { sql } from "bun";
import type { User } from "../../contracts/shared";
import { buildRoles } from "../accounts/authz";
import { resolveProviderProfile } from "../accounts/base-user";
import { managedGroupIdsSubquery, managedGroupsNamesSubquery } from "../accounts/group-sql";
import { buildIpaUserData, emptyIpaUserData, userIpaDataColumns, userIpaDataJoin } from "../accounts/ipa-data";
import { resolveAccountExpires } from "../accounts/model";
import { toPgTextArray } from "../postgres";

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
    roles: buildRoles({ provider, profile, memberofGroup, manages, admin: Boolean(row.effective_admin) }),
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
  return provider === "ipa"
    ? { ...common, provider: "ipa", ipa: buildIpaUserData(row) ?? emptyIpaUserData() }
    : { ...common, provider: "local", ipa: null };
};

export const userProjectionSql = (groupsAdmin: string[]) => sql`
  u.*,
  ${userIpaDataColumns},
  CASE
    WHEN u.provider = 'local' THEN u.admin
    ELSE EXISTS(
      SELECT 1 FROM auth.ipa_user_effective_groups eg
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
  COALESCE(ARRAY(${managedGroupsNamesSubquery(sql`u.id`)}), '{}') AS manages,
  COALESCE(ARRAY(${managedGroupIdsSubquery(sql`u.id`)}), '{}') AS manages_group_ids
`;

export const loadJwtSessionUser = async (
  params: {
    userId: string;
    sid: string;
    authEpoch: number;
    groupsAdmin: string[];
  },
  query: typeof sql = sql,
): Promise<User | null> => {
  const rows = await query<DbRow[]>`
    SELECT ${userProjectionSql(params.groupsAdmin)}
    FROM auth.session_families sf
    JOIN auth.users u ON u.id = sf.user_id
    JOIN auth.signing_keys sk ON sk.kid = sf.signing_kid AND sk.state <> 'revoked'
    ${userIpaDataJoin}
    WHERE sf.sid = ${params.sid}::uuid
      AND sf.user_id = ${params.userId}::uuid
      AND sf.auth_epoch = ${params.authEpoch}
      AND u.auth_epoch = ${params.authEpoch}
      AND sf.revoked_at IS NULL
      AND sf.expires_at > now()
  `;
  return rows[0] ? buildProjectedUser(rows[0]) : null;
};

export const loadLegacySessionUser = async (
  params: {
    userId: string;
    sessionGeneration: number;
    groupsAdmin: string[];
  },
  query: typeof sql = sql,
): Promise<User | null> => {
  const rows = await query<DbRow[]>`
    SELECT ${userProjectionSql(params.groupsAdmin)}
    FROM auth.users u
    ${userIpaDataJoin}
    WHERE u.id = ${params.userId}::uuid
      AND u.legacy_session_generation <= ${params.sessionGeneration}
  `;
  return rows[0] ? buildProjectedUser(rows[0]) : null;
};

export const loadCurrentUser = async (params: { userId: string; groupsAdmin: string[] }, query: typeof sql = sql): Promise<User | null> => {
  const rows = await query<DbRow[]>`
    SELECT ${userProjectionSql(params.groupsAdmin)}
    FROM auth.users u
    ${userIpaDataJoin}
    WHERE u.id = ${params.userId}::uuid
  `;
  return rows[0] ? buildProjectedUser(rows[0]) : null;
};
