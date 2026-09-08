import { sql } from "bun";
import {
  DEFAULT_LINUX_IDENTITY_CONFIGURATION,
  isPosixName,
  LinuxIdentityConfigurationSchema,
  type LinuxIdentityConfiguration,
  type PosixIdentity,
  PosixOverridesSchema,
} from "../../contracts/posix";
import { freeipa } from "../../server/services";
import { getFreeIpaConfig } from "../freeipa-config";
import { readCompleteIpaList } from "../ipa/sync-planning";
import { decryptValue } from "../settings/crypto";
import * as settings from "../settings";
import { audit, type AuditActor } from "../audit";
import type { MutationResult } from "../../contracts/shared";

const CONFIG_KEY = "linux.identity_config";
export const POSIX_PAGE_SIZE = 50;
type Actor = { id: string; roles: readonly string[] };
export class PosixError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 403 | 404 | 409 = 409,
  ) {
    super(code);
  }
}
const requireAdmin = (actor: Actor): void => {
  if (!actor.roles.includes("admin")) throw new PosixError("admin_required", 403);
};
export type IpaIdRange = { start: number; end: number };

/** A fresh directory inventory is mandatory before reserving a local namespace. */
export const readIpaIdRanges = async (): Promise<IpaIdRange[]> => {
  const config = await getFreeIpaConfig();
  if (!config.configured) {
    if (config.enabled) throw new PosixError("ipa_inventory_unavailable");
    return [];
  }
  try {
    const ipaSession = await freeipa.session.getServiceSession({
      url: config.url,
      serviceUser: config.serviceUser,
      servicePassword: config.servicePassword,
    });
    const response = await freeipa.client.call({
      url: config.url,
      ipaSession,
      method: "idrange_find",
      args: [],
      options: { sizelimit: 0, all: true },
    });
    const records = readCompleteIpaList({ response, entity: "ID ranges" });
    if (records.length === 0) throw new Error("Missing ranges");
    return records.map((record) => {
      const start = freeipa.util.num(record.ipabaseid);
      const size = freeipa.util.num(record.ipaidrangesize);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start === null || size === null || start < 1 || size < 1)
        throw new Error("Invalid range");
      return { start, end: start + size - 1 };
    });
  } catch {
    throw new PosixError("ipa_inventory_unavailable");
  }
};

export type PosixCandidate = {
  id: string;
  uid: string;
  displayName: string;
  provider: "local" | "ipa";
  profile: "user" | "guest";
  identity: PosixIdentity | null;
  state: "ready" | "prepared" | "guest" | "invalid_name" | "group_conflict" | "ipa_pending" | "provider_changed" | "identity_conflict";
};
type IdentityRow = {
  id: string;
  uid: string;
  display_name: string;
  provider: "local" | "ipa";
  profile: "user" | "guest";
  managed_by: "local" | "ipa" | null;
  uid_number: number | null;
  primary_gid_number: number | null;
  home_directory: string | null;
  login_shell: string | null;
  group_conflict: boolean;
  identity_conflict: boolean;
};
const candidate = (row: IdentityRow): PosixCandidate => {
  const identity = row.managed_by
    ? {
        userId: row.id,
        managedBy: row.managed_by,
        uidNumber: row.uid_number,
        primaryGidNumber: row.primary_gid_number,
        homeDirectory: row.home_directory,
        loginShell: row.login_shell,
      }
    : null;
  const state =
    identity && identity.managedBy !== row.provider
      ? "provider_changed"
      : row.identity_conflict ||
          (identity &&
            ((identity.uidNumber !== null && identity.uidNumber <= 0) ||
              (identity.primaryGidNumber !== null && identity.primaryGidNumber <= 0)))
        ? "identity_conflict"
        : row.provider === "ipa" &&
            (!identity ||
              identity.uidNumber === null ||
              identity.primaryGidNumber === null ||
              !identity.homeDirectory ||
              !identity.loginShell)
          ? "ipa_pending"
          : row.provider === "local" && row.profile === "guest"
            ? "guest"
            : identity
              ? "prepared"
              : !isPosixName(row.uid)
                ? "invalid_name"
                : row.group_conflict
                  ? "group_conflict"
                  : "ready";
  return { id: row.id, uid: row.uid, displayName: row.display_name, provider: row.provider, profile: row.profile, identity, state };
};

// Database injection is used by isolated integration tests; production uses the shared pool.
export const createPosixRuntime = (db: typeof sql = sql, readRanges = readIpaIdRanges) => {
  const readConfig = async (connection = db): Promise<LinuxIdentityConfiguration> => {
    // Provisioning must not use a stale cache after an operator disables or changes the range.
    const [row] = await connection<{ value: string }[]>`SELECT value FROM settings.entries WHERE key = ${CONFIG_KEY}`;
    const raw = row ? await decryptValue(row.value) : JSON.stringify(DEFAULT_LINUX_IDENTITY_CONFIGURATION);
    try {
      return LinuxIdentityConfigurationSchema.parse(typeof raw === "string" ? JSON.parse(raw) : raw);
    } catch {
      throw new PosixError("invalid_configuration", 400);
    }
  };
  const lock = async (connection: typeof sql): Promise<void> => {
    // Also serialize against existing provider writers, not just this allocator.
    await connection`LOCK TABLE auth.users, auth.user_ipa_data, auth.groups, auth.user_posix, auth.posix_allocations IN SHARE ROW EXCLUSIVE MODE`;
    await connection`LOCK TABLE settings.entries IN SHARE MODE`;
  };
  const checkRange = async (connection: typeof sql, config: LinuxIdentityConfiguration, ranges: IpaIdRange[]) => {
    if (ranges.length === 0) {
      const [ipaState] = await connection`SELECT 1 FROM auth.users WHERE provider = 'ipa'
        UNION ALL SELECT 1 FROM auth.groups WHERE provider = 'ipa'
        UNION ALL SELECT 1 FROM auth.user_posix WHERE managed_by = 'ipa' LIMIT 1`;
      if (ipaState) throw new PosixError("ipa_inventory_unavailable");
    }
    if (ranges.some((range) => config.rangeStart <= range.end && config.rangeEnd >= range.start))
      throw new PosixError("ipa_range_conflict");
    const [conflict] = await connection`
      SELECT 1 FROM auth.user_ipa_data WHERE uid_number BETWEEN ${config.rangeStart} AND ${config.rangeEnd}
      UNION ALL SELECT 1 FROM auth.user_posix WHERE managed_by = 'ipa' AND
        (uid_number BETWEEN ${config.rangeStart} AND ${config.rangeEnd} OR primary_gid_number BETWEEN ${config.rangeStart} AND ${config.rangeEnd})
      UNION ALL SELECT 1 FROM auth.groups WHERE provider = 'ipa' AND gid_number BETWEEN ${config.rangeStart} AND ${config.rangeEnd}
      LIMIT 1
    `;
    if (conflict) throw new PosixError("ipa_range_conflict");
  };
  const rows = (
    connection: typeof sql,
    id: string | null,
    after: string | null,
    filters: { search?: string; scope?: "ready" | "all" } = {},
  ) => connection<IdentityRow[]>`
    WITH candidates AS (
    SELECT u.id, u.uid, u.display_name, u.provider, u.profile,
      COALESCE(p.managed_by, CASE WHEN u.provider = 'ipa' AND i.user_id IS NOT NULL THEN 'ipa' END) AS managed_by,
      CASE WHEN p.user_id IS NOT NULL THEN p.uid_number WHEN u.provider = 'ipa' THEN i.uid_number END AS uid_number,
      p.primary_gid_number, p.home_directory, p.login_shell,
      EXISTS(SELECT 1 FROM auth.groups g WHERE lower(g.name) = lower(u.uid)) AS group_conflict,
      (EXISTS(SELECT 1 FROM auth.users other WHERE other.id <> u.id AND lower(other.uid) = lower(u.uid))
        OR EXISTS(SELECT 1 FROM auth.user_posix other WHERE other.user_id <> u.id AND other.uid_number = COALESCE(p.uid_number, i.uid_number))
        OR EXISTS(SELECT 1 FROM auth.user_ipa_data other WHERE other.user_id <> u.id AND other.uid_number = COALESCE(p.uid_number, i.uid_number))
        OR EXISTS(SELECT gid_number FROM auth.groups WHERE gid_number = p.primary_gid_number GROUP BY gid_number HAVING count(*) > 1)) AS identity_conflict
    FROM auth.users u LEFT JOIN auth.user_posix p ON p.user_id = u.id
    LEFT JOIN auth.user_ipa_data i ON i.user_id = u.id
    WHERE (${id}::uuid IS NULL OR u.id = ${id}::uuid) AND (${after}::uuid IS NULL OR u.id > ${after}::uuid)
      AND strpos(lower(u.uid), lower(${filters.search ?? ""})) > 0
    )
    SELECT * FROM candidates
    WHERE (${filters.scope === "ready"} = false OR (
      provider = 'local' AND profile = 'user' AND managed_by IS NULL
      AND uid ~ '^[a-z_][a-z0-9_-]{0,31}$' AND NOT group_conflict AND NOT identity_conflict
    ))
    ORDER BY id LIMIT ${id ? 1 : POSIX_PAGE_SIZE + 1}
  `;
  const allocate = async (
    connection: typeof sql,
    kind: "uid" | "gid",
    ownerId: string,
    config: LinuxIdentityConfiguration,
  ): Promise<number> => {
    // The high-water mark survives deletion and range changes. No generate_series over a potentially huge range.
    const [row] = await connection<{ number: number | null }[]>`
      SELECT GREATEST(${config.rangeStart}::bigint, COALESCE(MAX(number)::bigint + 1, ${config.rangeStart}::bigint)) AS number
      FROM auth.posix_allocations WHERE kind = ${kind} AND number BETWEEN ${config.rangeStart} AND ${config.rangeEnd}
    `;
    let number = Number(row?.number);
    // Skip pre-existing identities without allocating/reusing their numbers.
    const [occupied] =
      kind === "uid"
        ? await connection<
            { number: number | null }[]
          >`SELECT MAX(number) AS number FROM (SELECT uid_number AS number FROM auth.user_posix WHERE uid_number BETWEEN ${number} AND ${config.rangeEnd} UNION ALL SELECT uid_number FROM auth.user_ipa_data WHERE uid_number BETWEEN ${number} AND ${config.rangeEnd}) occupied`
        : await connection<
            { number: number | null }[]
          >`SELECT MAX(number) AS number FROM (SELECT gid_number AS number FROM auth.groups WHERE gid_number BETWEEN ${number} AND ${config.rangeEnd} UNION ALL SELECT primary_gid_number FROM auth.user_posix WHERE primary_gid_number BETWEEN ${number} AND ${config.rangeEnd}) occupied`;
    if (occupied?.number != null) number = occupied.number + 1;
    if (!Number.isSafeInteger(number) || number > config.rangeEnd) throw new PosixError("range_exhausted");
    await connection`INSERT INTO auth.posix_allocations(kind, number, owner_id) VALUES (${kind}, ${number}, ${ownerId}::uuid)`;
    return number;
  };
  const assign = async (tx: typeof sql, id: string, config: LinuxIdentityConfiguration, actor?: AuditActor) => {
    const [row] = await rows(tx, id, null);
    if (!row) throw new PosixError("user_not_found", 404);
    const current = candidate(row);
    if (current.state === "prepared" && row.provider === "local" && row.profile === "user") return current;
    if (current.state !== "ready") throw new PosixError(current.state);
    await checkRange(tx, config, await readRanges());
    const paths = PosixOverridesSchema.safeParse({
      homeDirectory: config.homeTemplate.replaceAll("{username}", row.uid),
      loginShell: config.loginShell,
    });
    if (!paths.success) throw new PosixError("invalid_paths", 400);
    const uidNumber = await allocate(tx, "uid", id, config);
    const groupId = crypto.randomUUID();
    const gidNumber = await allocate(tx, "gid", groupId, config);
    await tx`INSERT INTO auth.groups(id, cn, provider, name, gid_number) VALUES (${groupId}::uuid, ${`local:${row.uid}`}, 'local', ${row.uid}, ${gidNumber})`;
    await tx`INSERT INTO auth.user_groups_v2(user_id, group_id) VALUES (${id}::uuid, ${groupId}::uuid)`;
    await tx`INSERT INTO auth.user_posix(user_id, managed_by, uid_number, primary_gid_number, primary_group_id, home_directory, login_shell)
      VALUES (${id}::uuid, 'local', ${uidNumber}, ${gidNumber}, ${groupId}::uuid, ${paths.data.homeDirectory}, ${paths.data.loginShell})`;
    await audit.record(
      {
        action: "accounts.linux.provision",
        outcome: "allowed",
        actor,
        target: { type: "user", id },
        metadata: { uidNumber, gidNumber, primaryGroupId: groupId },
      },
      tx,
    );
    const [created] = await rows(tx, id, null);
    return candidate(created!);
  };

  // Internal lifecycle boundary, not part of the public administrator service.
  // Lock before the account write: upgrading a row-write lock afterwards can deadlock.
  const writeLocalAccount = async (
    write: (tx: typeof sql) => Promise<MutationResult<{ id: string; assignIdentity?: boolean }>>,
    actor?: AuditActor,
  ): Promise<MutationResult<{ id: string }>> => {
    try {
      return await db.begin(async (tx) => {
        await lock(tx);
        const result = await write(tx);
        if (!result.ok) return result;
        const [user] = await tx<
          { provider: string; profile: string }[]
        >`SELECT provider, profile FROM auth.users WHERE id = ${result.data.id}::uuid`;
        if (result.data.assignIdentity !== false && user?.provider === "local" && user.profile === "user") {
          const config = await readConfig(tx);
          if (config.enabled) await assign(tx, result.data.id, config, actor);
        }
        return { ok: true, data: { id: result.data.id } };
      });
    } catch (error) {
      if (error instanceof PosixError) return { ok: false, error: `Linux identity assignment failed: ${error.code}`, status: error.status };
      throw error;
    }
  };

  const service = {
    async configuration(actor: Actor) {
      requireAdmin(actor);
      return readConfig();
    },
    async overview(actor: Actor, after: string | null = null, filters: { search?: string; scope?: "ready" | "all" } = {}) {
      requireAdmin(actor);
      const result = await rows(db, null, after, filters);
      const items = result.slice(0, POSIX_PAGE_SIZE).map(candidate);
      return { config: await readConfig(), items, nextCursor: result.length > POSIX_PAGE_SIZE ? items.at(-1)!.id : null };
    },
    async get(actor: Actor, id: string) {
      requireAdmin(actor);
      const [row] = await rows(db, id, null);
      if (!row) throw new PosixError("user_not_found", 404);
      return { config: await readConfig(), user: candidate(row) };
    },
    async configure(actor: Actor, input: LinuxIdentityConfiguration) {
      requireAdmin(actor);
      const parsed = LinuxIdentityConfigurationSchema.safeParse(input);
      if (!parsed.success) throw new PosixError("invalid_configuration", 400);
      const ranges = parsed.data.enabled ? await readRanges() : [];
      await db.begin(async (tx) => {
        // Same order as provisioning; settings write upgrades this lock in the same transaction.
        await lock(tx);
        if (parsed.data.enabled) await checkRange(tx, parsed.data, ranges);
        await settings.set(CONFIG_KEY, JSON.stringify(parsed.data), tx);
        await audit.record(
          {
            action: "accounts.linux.configure",
            outcome: "allowed",
            actor: { userId: actor.id, roles: actor.roles },
            metadata: parsed.data,
          },
          tx,
        );
      });
      await settings.invalidateSettingsCache([CONFIG_KEY]);
      return parsed.data;
    },
    async provision(actor: Actor, id: string) {
      requireAdmin(actor);
      return db.begin(async (tx) => {
        await lock(tx);
        const config = await readConfig(tx);
        if (!config.enabled) throw new PosixError("setup_disabled");
        return assign(tx, id, config, { userId: actor.id, roles: actor.roles });
      });
    },
    async update(actor: Actor, id: string, input: { homeDirectory: string; loginShell: string }) {
      requireAdmin(actor);
      const parsed = PosixOverridesSchema.safeParse(input);
      if (!parsed.success) throw new PosixError("invalid_paths", 400);
      return db.begin(async (tx) => {
        await lock(tx);
        const [row] = await rows(tx, id, null);
        if (!row) throw new PosixError("user_not_found", 404);
        if (row.provider !== "local" || row.managed_by !== "local" || row.profile !== "user")
          throw new PosixError("identity_not_locally_managed");
        await tx`UPDATE auth.user_posix SET home_directory = ${parsed.data.homeDirectory}, login_shell = ${parsed.data.loginShell} WHERE user_id = ${id}::uuid`;
        await audit.record(
          {
            action: "accounts.linux.update",
            outcome: "allowed",
            actor: { userId: actor.id, roles: actor.roles },
            target: { type: "user", id },
            metadata: { before: { homeDirectory: row.home_directory, loginShell: row.login_shell }, after: parsed.data },
          },
          tx,
        );
        return { ...candidate(row), identity: { ...candidate(row).identity!, ...parsed.data } };
      });
    },
    async provisionGroup(actor: Actor, id: string) {
      requireAdmin(actor);
      const ranges = await readRanges();
      return db.begin(async (tx) => {
        await lock(tx);
        const config = await readConfig(tx);
        if (!config.enabled) throw new PosixError("setup_disabled");
        const [group] = await tx<
          { id: string; name: string; provider: string; gid_number: number | null }[]
        >`SELECT id, name, provider, gid_number FROM auth.groups WHERE id = ${id}::uuid`;
        if (!group) throw new PosixError("group_not_found", 404);
        if (group.provider !== "local") throw new PosixError("identity_not_locally_managed");
        if (group.gid_number !== null) return { gidNumber: group.gid_number };
        if (!isPosixName(group.name)) throw new PosixError("invalid_name");
        const [conflict] = await tx`SELECT 1 FROM auth.groups WHERE id <> ${id}::uuid AND lower(name) = lower(${group.name}) LIMIT 1`;
        if (conflict) throw new PosixError("group_conflict");
        await checkRange(tx, config, ranges);
        const gidNumber = await allocate(tx, "gid", id, config);
        await tx`UPDATE auth.groups SET gid_number = ${gidNumber} WHERE id = ${id}::uuid`;
        await audit.record(
          {
            action: "accounts.linux.provision_group",
            outcome: "allowed",
            actor: { userId: actor.id, roles: actor.roles },
            target: { type: "group", id },
            metadata: { gidNumber },
          },
          tx,
        );
        return { gidNumber };
      });
    },
  };
  return { service, writeLocalAccount };
};
export const createPosixService = (db: typeof sql = sql, readRanges = readIpaIdRanges) => createPosixRuntime(db, readRanges).service;
export const { service: posix, writeLocalAccount } = createPosixRuntime();
