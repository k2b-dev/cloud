import type { SQL } from "bun";
import type {
  AccountDirectoryEntry,
  AccountDirectoryKind,
  AccountDirectoryStatus,
  UserDirectoryRole,
  UserProvider,
} from "../../contracts/shared";
import { sql } from "../../runtime/clients";
import { freeipa } from "../../server/services";
import { getFreeIpaConfig } from "../freeipa-config";
import { toPgTextArray, toPgUuidArray } from "../postgres";
import { buildBaseUser } from "./base-user";

type DbRow = Record<string, unknown>;

/** Most groups one entry of the account list names; `groupCount` still counts all of them. */
export const USER_DIRECTORY_GROUPS_MAX = 50;
/** Most groups one filter of the account list names. */
export const USER_DIRECTORY_GROUP_FILTER_MAX = 20;
/** Longest free search of the account list. */
export const USER_DIRECTORY_SEARCH_MAX = 200;

/**
 * What the administration's account list asks for. Every part narrows the list; an absent part does not. The parts
 * only a person has (provider, role, groups, last sign-in, passkey, shared address) narrow the list to people.
 */
export type AccountDirectoryQuery = {
  /** People, agents and API key accounts (`standalone`); absent means all three. No other service account is listed. */
  kinds?: readonly AccountDirectoryKind[];
  search?: string;
  provider?: UserProvider;
  roles?: readonly UserDirectoryRole[];
  /** Direct members of any of these groups. */
  groupIds?: readonly string[];
  /** A person is active, invited or expired; a service account is active or disabled. */
  statuses?: readonly AccountDirectoryStatus[];
  /** The last sign-in: within `[since, until)`, or `"never"` for accounts that never signed in. */
  lastLogin?: { since?: Date; until?: Date } | "never";
  passkey?: boolean;
  /** People whose address (trimmed, any case) another account shares, as the duplicate address check reads it. */
  duplicateMail?: boolean;
  /** `lastLogin` is a person's last sign-in and a service account's last API key use; `mail` lists accounts without one last. */
  sort?: { field: "name" | "lastLogin" | "mail"; direction: "asc" | "desc" };
  page?: number;
  perPage?: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERSON_STATUSES = new Set<AccountDirectoryStatus>(["active", "invited", "expired"]);
const SERVICE_STATUSES = new Set<AccountDirectoryStatus>(["active", "disabled"]);
/** The service account kind behind each listed kind; the list never reads another kind. */
const SERVICE_KINDS = { agent: "agent", "api-key": "standalone" } as const;

const and = (conditions: SQL.Query<unknown>[]) => conditions.reduce((acc, condition) => sql`${acc} AND ${condition}`);
const or = (parts: SQL.Query<unknown>[]) => sql`(${parts.reduce((acc, part) => sql`${acc} OR ${part}`)})`;

/**
 * The administration's account list: people and the service accounts an administrator manages (agents and API key
 * accounts) with filters, sort and the facts each row shows, in two statements (a count and the page). Groups are
 * direct memberships without personal Linux groups, the same set the row names.
 */
export const accountDirectory = async (query: AccountDirectoryQuery): Promise<{ items: AccountDirectoryEntry[]; total: number }> => {
  const page = query.page ?? 1;
  const perPage = query.perPage ?? 100;
  if (query.search && query.search.length > USER_DIRECTORY_SEARCH_MAX) throw new RangeError("search too long");
  const groupIds = query.groupIds;
  if (groupIds && (groupIds.length > USER_DIRECTORY_GROUP_FILTER_MAX || !groupIds.every((id) => UUID.test(id))))
    throw new RangeError("invalid group filter");
  if (groupIds?.length === 0 || query.roles?.length === 0 || query.statuses?.length === 0 || query.kinds?.length === 0)
    return { items: [], total: 0 };

  const kinds = new Set(query.kinds ?? ["person", "agent", "api-key"]);
  const statuses = query.statuses ? new Set(query.statuses) : null;
  const personOnly =
    query.provider !== undefined ||
    query.roles !== undefined ||
    groupIds !== undefined ||
    query.lastLogin !== undefined ||
    query.passkey !== undefined ||
    query.duplicateMail !== undefined;
  const people = kinds.has("person") && (!statuses || [...statuses].some((status) => PERSON_STATUSES.has(status)));
  const serviceKinds = personOnly
    ? []
    : (["agent", "api-key"] as const).filter((kind) => kinds.has(kind)).map((kind) => SERVICE_KINDS[kind]);
  const services = serviceKinds.length > 0 && (!statuses || [...statuses].some((status) => SERVICE_STATUSES.has(status)));
  if (!people && !services) return { items: [], total: 0 };
  const search = query.search ? `%${freeipa.util.escapeLike(query.search.toLowerCase())}%` : null;
  // One address another account shares, as `listDuplicateEmails` groups them; Postgres hashes this set once.
  const sharedAddresses = sql`(
    SELECT lower(btrim(mail)) FROM auth.users WHERE NULLIF(btrim(mail), '') IS NOT NULL GROUP BY lower(btrim(mail)) HAVING count(*) > 1
  )`;

  let personFrom: SQL.Query<unknown> | null = null;
  let personWhere: SQL.Query<unknown> | null = null;
  if (people) {
    const groupsAdmin = (await getFreeIpaConfig()).groupsAdmin;
    // As `buildRoles`: only a full account is an administrator, also a FreeIPA guest in an administrators' group is not.
    const adminExpression = sql`u.profile = 'user' AND CASE
      WHEN u.provider = 'local' THEN u.admin
      ELSE EXISTS(
        SELECT 1 FROM auth.ipa_user_effective_groups eg
        WHERE eg.user_id = u.id AND eg.group_name = ANY(${toPgTextArray(groupsAdmin)}::text[])
      )
    END`;
    const expired = sql`(u.account_expires IS NOT NULL AND u.account_expires <= now())`;
    const conditions: SQL.Query<unknown>[] = [sql`TRUE`];
    if (query.provider) conditions.push(sql`u.provider = ${query.provider}`);
    if (search) {
      conditions.push(sql`(
        LOWER(u.uid) LIKE ${search} ESCAPE '\\' OR
        LOWER(u.display_name) LIKE ${search} ESCAPE '\\' OR
        LOWER(u.given_name) LIKE ${search} ESCAPE '\\' OR
        LOWER(u.sn) LIKE ${search} ESCAPE '\\' OR
        LOWER(u.mail) LIKE ${search} ESCAPE '\\'
      )`);
    }
    if (query.roles) {
      const roles = new Set(query.roles);
      const parts: SQL.Query<unknown>[] = [];
      if (roles.has("admin")) parts.push(sql`a.effective_admin`);
      if (roles.has("member")) parts.push(sql`(NOT a.effective_admin AND u.profile = 'user')`);
      if (roles.has("guest")) parts.push(sql`u.profile = 'guest'`);
      conditions.push(or(parts));
    }
    if (groupIds) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM auth.user_groups_v2 ug WHERE ug.user_id = u.id AND ug.group_id = ANY(${toPgUuidArray([...groupIds])}::uuid[])
      )`);
    }
    if (statuses) {
      const parts: SQL.Query<unknown>[] = [];
      if (statuses.has("expired")) parts.push(expired);
      if (statuses.has("invited")) parts.push(sql`(NOT ${expired} AND u.last_login_local IS NULL)`);
      if (statuses.has("active")) parts.push(sql`(NOT ${expired} AND u.last_login_local IS NOT NULL)`);
      conditions.push(or(parts));
    }
    if (query.lastLogin === "never") conditions.push(sql`u.last_login_local IS NULL`);
    else if (query.lastLogin) {
      if (query.lastLogin.since) conditions.push(sql`u.last_login_local >= ${query.lastLogin.since}`);
      if (query.lastLogin.until) conditions.push(sql`u.last_login_local < ${query.lastLogin.until}`);
    }
    if (query.passkey !== undefined) {
      const exists = sql`EXISTS (SELECT 1 FROM auth.webauthn_credentials w WHERE w.user_id = u.id)`;
      conditions.push(query.passkey ? exists : sql`NOT ${exists}`);
    }
    if (query.duplicateMail !== undefined) {
      const shared = sql`COALESCE(lower(btrim(u.mail)) IN ${sharedAddresses}, FALSE)`;
      conditions.push(query.duplicateMail ? shared : sql`NOT ${shared}`);
    }
    personFrom = sql`auth.users u CROSS JOIN LATERAL (SELECT ${adminExpression} AS effective_admin) a`;
    personWhere = and(conditions);
  }

  let serviceWhere: SQL.Query<unknown> | null = null;
  if (services) {
    const conditions: SQL.Query<unknown>[] = [sql`s.kind = ANY(${toPgTextArray(serviceKinds)}::text[])`];
    if (search) conditions.push(sql`LOWER(s.name) LIKE ${search} ESCAPE '\\'`);
    if (statuses) {
      const wanted = [...statuses].filter((status) => SERVICE_STATUSES.has(status));
      conditions.push(sql`s.status = ANY(${toPgTextArray(wanted)}::text[])`);
    }
    serviceWhere = and(conditions);
  }

  const counts = [
    personFrom && personWhere ? sql`(SELECT COUNT(*) FROM ${personFrom} WHERE ${personWhere})` : null,
    serviceWhere ? sql`(SELECT COUNT(*) FROM auth.service_accounts s WHERE ${serviceWhere})` : null,
  ].filter((part) => part !== null);
  const countRows = await sql<DbRow[]>`SELECT (${counts.reduce((acc, part) => sql`${acc} + ${part}`)})::int AS count`;
  const total = (countRows[0]?.count as number) ?? 0;

  // The keys of every matching account, so only the page's rows read their groups, passkeys and shared address.
  const keys = [
    personFrom && personWhere
      ? sql`SELECT 'person'::text AS entry_kind, u.id, a.effective_admin,
          LOWER(COALESCE(NULLIF(u.display_name, ''), u.mail, u.uid)) AS sort_name,
          u.last_login_local AS sort_time, NULLIF(lower(btrim(u.mail)), '') AS sort_mail, u.uid AS tie
        FROM ${personFrom} WHERE ${personWhere}`
      : null,
    serviceWhere
      ? sql`SELECT CASE WHEN s.kind = 'agent' THEN 'agent' ELSE 'api-key' END AS entry_kind, s.id, NULL::boolean AS effective_admin,
          LOWER(s.name) AS sort_name,
          (SELECT max(c.last_used_at) FROM auth.service_account_credentials c WHERE c.service_account_id = s.id) AS sort_time,
          NULL::text AS sort_mail, s.id::text AS tie
        FROM auth.service_accounts s WHERE ${serviceWhere}`
      : null,
  ].filter((part) => part !== null);
  const union = keys.reduce((acc, part) => sql`${acc} UNION ALL ${part}`);

  const sort = query.sort ?? { field: "name", direction: "asc" };
  // Ties end on the unique uid (a service account's id), so pages never repeat or skip a row. "Never" is the oldest.
  const order =
    sort.field === "lastLogin"
      ? sort.direction === "desc"
        ? sql`sort_time DESC NULLS LAST, tie`
        : sql`sort_time ASC NULLS FIRST, tie`
      : sort.field === "mail"
        ? sort.direction === "desc"
          ? sql`sort_mail DESC NULLS LAST, sort_name DESC, tie DESC`
          : sql`sort_mail ASC NULLS LAST, sort_name ASC, tie ASC`
        : sort.direction === "desc"
          ? sql`sort_name DESC, tie DESC`
          : sql`sort_name ASC, tie ASC`;
  const ownGroups = sql`
    SELECT g.id, g.name FROM auth.user_groups_v2 ug JOIN auth.groups g ON g.id = ug.group_id
    WHERE ug.user_id = u.id AND NOT EXISTS (SELECT 1 FROM auth.personal_groups p WHERE p.group_id = g.id)
  `;
  const rows = await sql<DbRow[]>`
    SELECT p.entry_kind, p.id, p.effective_admin, p.sort_time,
      u.uid, u.provider, u.profile, u.given_name, u.sn, u.display_name, u.mail, u.avatar_hash,
      u.account_expires, u.last_login_local,
      (u.account_expires IS NOT NULL AND u.account_expires <= now()) AS expired,
      EXISTS (SELECT 1 FROM auth.webauthn_credentials w WHERE w.user_id = u.id) AS has_passkey,
      COALESCE(lower(btrim(u.mail)) IN ${sharedAddresses}, FALSE) AS duplicate_mail,
      COALESCE((
        SELECT json_agg(json_build_object('id', o.id, 'name', o.name) ORDER BY o.name)
        FROM (${ownGroups} ORDER BY g.name LIMIT ${USER_DIRECTORY_GROUPS_MAX}) o
      ), '[]'::json) AS directory_groups,
      (SELECT COUNT(*)::int FROM (${ownGroups}) c) AS directory_group_count,
      s.name AS service_name, s.status AS service_status, s.avatar_hash AS service_avatar_hash, s.created_at AS service_created_at
    FROM (SELECT * FROM (${union}) x ORDER BY ${order} LIMIT ${perPage} OFFSET ${(page - 1) * perPage}) p
    LEFT JOIN auth.users u ON p.entry_kind = 'person' AND u.id = p.id
    LEFT JOIN auth.service_accounts s ON p.entry_kind <> 'person' AND s.id = p.id
    ORDER BY ${order}
  `;
  const iso = (value: unknown) => (value ? (value as Date).toISOString() : null);
  return {
    total,
    items: rows.map((row): AccountDirectoryEntry => {
      if (row.entry_kind !== "person")
        return {
          kind: row.entry_kind as "agent" | "api-key",
          id: row.id as string,
          name: row.service_name as string,
          status: row.service_status as "active" | "disabled",
          avatarHash: (row.service_avatar_hash as string | null) ?? null,
          lastUsed: iso(row.sort_time),
          createdAt: (row.service_created_at as Date).toISOString(),
        };
      const base = buildBaseUser(row);
      const lastLogin = iso(row.last_login_local);
      const groupList = (typeof row.directory_groups === "string" ? JSON.parse(row.directory_groups) : row.directory_groups) as {
        id: string;
        name: string;
      }[];
      return {
        kind: "person",
        ...base,
        role: row.effective_admin ? "admin" : base.profile === "guest" ? "guest" : "member",
        status: row.expired ? "expired" : lastLogin ? "active" : "invited",
        lastLogin,
        accountExpires: iso(row.account_expires),
        passkey: Boolean(row.has_passkey),
        groups: groupList,
        groupCount: (row.directory_group_count as number) ?? 0,
        duplicateMail: Boolean(row.duplicate_mail),
      };
    }),
  };
};
