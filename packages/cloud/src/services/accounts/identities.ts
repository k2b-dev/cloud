import { type SQLQuery, sql } from "bun";
import { z } from "zod";
import { DEFAULT_LINUX_IDENTITY_CONFIGURATION, LinuxIdentityConfigurationSchema } from "../../contracts/posix";
import type { RequestActor, UserProfile, UserProvider } from "../../contracts/shared";
import { userFromActor } from "../../server/actor";
import { isAccountCategoryAllowed } from "../account-category-policy";
import { toPgTextArray } from "../postgres";
import { decryptValue } from "../settings/crypto";
import { buildMemberGroupScopeCondition } from "./group-sql";
import { type AccountIdentityReconciliation, readUpstreamIdentity } from "./identity-reconciliation";

export type AccountIdentityUser = {
  id: string;
  provider: UserProvider;
  username: string;
  profile: UserProfile;
  posix: { uidNumber: number; primaryGidNumber: number } | null;
};
/** `personal` marks a user's personal Linux group (their stored primary group). */
export type AccountIdentityGroup = { id: string; provider: UserProvider; name: string; gidNumber: number | null; personal: boolean };
export type AccountIdentityPage<T> = { items: T[]; nextCursor: string | null };
export type AccountIdentityAvailability = { localLinuxEnabled: boolean; freeipaEnabled: boolean };
type InventoryFilter = { provider: UserProvider; after?: string; id?: string; name?: string };

export class AccountIdentityError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 401 | 403 = 403,
  ) {
    super(code);
  }
}

// The same bounded page size as Linux identity administration.
const PAGE_SIZE = 50;
const cursorSchema = z.uuid();
const positiveId = (value: number | null): value is number => Number.isSafeInteger(value) && value !== null && value > 0;
type UserRow = {
  id: string;
  provider: UserProvider;
  uid: string;
  profile: UserProfile;
  admin: boolean;
  expired: boolean;
  managed_by: UserProvider | null;
  uid_number: number | null;
  primary_gid_number: number | null;
};
const projectUser = (row: UserRow): AccountIdentityUser => ({
  id: row.id,
  provider: row.provider,
  username: row.uid,
  profile: row.profile,
  posix:
    row.managed_by === row.provider && positiveId(row.uid_number) && positiveId(row.primary_gid_number)
      ? { uidNumber: row.uid_number, primaryGidNumber: row.primary_gid_number }
      : null,
});
const page = <T extends { id: string }>(rows: T[]): AccountIdentityPage<T> => ({
  items: rows.slice(0, PAGE_SIZE),
  nextCursor: rows.length > PAGE_SIZE ? rows[PAGE_SIZE - 1]!.id : null,
});
const cursor = (after?: string): string | null => {
  if (after !== undefined && !cursorSchema.safeParse(after).success) throw new AccountIdentityError("invalid_cursor", 400);
  return after ?? null;
};

/** Server-side identity reads. Authentication and application resource authorization remain caller-owned. */
export const createAccountIdentityService = (db: typeof sql = sql, upstreamIdentity = readUpstreamIdentity) => {
  const setting = async (key: string, fallback: unknown): Promise<unknown> => {
    const [row] = await db<{ value: string }[]>`SELECT value FROM settings.entries WHERE key = ${key}`;
    return row ? decryptValue(row.value) : fallback;
  };
  const availability = async (): Promise<AccountIdentityAvailability> => {
    const [raw, ipa] = await Promise.all([
      setting("linux.identity_config", DEFAULT_LINUX_IDENTITY_CONFIGURATION),
      setting("freeipa.enable", false),
    ]);
    try {
      const config = LinuxIdentityConfigurationSchema.parse(typeof raw === "string" ? JSON.parse(raw) : raw);
      if (typeof ipa !== "boolean") throw new Error("Invalid FreeIPA state");
      return { localLinuxEnabled: config.enabled, freeipaEnabled: ipa };
    } catch {
      throw new AccountIdentityError("invalid_identity_configuration");
    }
  };
  const userRows = (filter: SQLQuery) => db<UserRow[]>`
    SELECT u.id, u.provider, u.uid, u.profile, u.admin,
      (u.account_expires IS NOT NULL AND u.account_expires <= now()) AS expired,
      p.managed_by, p.uid_number, p.primary_gid_number
    FROM auth.users u LEFT JOIN auth.user_posix p ON p.user_id = u.id
    WHERE ${filter}
    ORDER BY u.id LIMIT ${PAGE_SIZE + 1}
  `;
  const requireUser = async (actor: RequestActor) => {
    const supplied = userFromActor(actor);
    if (!supplied) throw new AccountIdentityError("user_required", 401);
    const [row] = await userRows(sql`u.id = ${supplied.id}::uuid`);
    if (!row || row.expired || row.provider !== supplied.provider || row.uid !== supplied.uid || row.profile !== supplied.profile)
      throw new AccountIdentityError("identity_unavailable");
    if (!(await isAccountCategoryAllowed(row, db))) throw new AccountIdentityError("identity_unavailable");
    const state = await availability();
    if (row.provider === "ipa" && !state.freeipaEnabled) throw new AccountIdentityError("identity_unavailable");
    return { row, state, supplied };
  };
  const requireAdmin = async (actor: RequestActor) => {
    const current = await requireUser(actor);
    if (!current.supplied.roles.includes("admin")) throw new AccountIdentityError("admin_required");
    if (current.row.provider === "local") {
      if (!current.row.admin || current.row.profile !== "user") throw new AccountIdentityError("admin_required");
    } else {
      const configured = await setting("freeipa.groups.admin", ["admins"]);
      if (!Array.isArray(configured) || !configured.every((value): value is string => typeof value === "string"))
        throw new AccountIdentityError("invalid_identity_configuration");
      const names = configured.length > 0 ? configured : ["admins"];
      const [membership] = await db`SELECT 1 FROM auth.ipa_user_effective_groups
        WHERE user_id = ${current.row.id}::uuid AND group_name = ANY(${toPgTextArray(names)}::text[]) LIMIT 1`;
      if (!membership) throw new AccountIdentityError("admin_required");
    }
    return current;
  };
  const groupRows = async (filter: SQLQuery) => {
    const rows = await db<{ id: string; provider: UserProvider; name: string; gid_number: number | null; personal: boolean }[]>`
      SELECT g.id, g.provider, g.name, g.gid_number,
        EXISTS(SELECT 1 FROM auth.user_posix p WHERE p.primary_group_id = g.id) AS personal
      FROM auth.groups g
      WHERE ${filter} ORDER BY g.id LIMIT ${PAGE_SIZE + 1}
    `;
    return rows.map(
      (row): AccountIdentityGroup => ({
        id: row.id,
        provider: row.provider,
        name: row.name,
        gidNumber: positiveId(row.gid_number) ? row.gid_number : null,
        personal: row.personal,
      }),
    );
  };
  async function inventory(
    actor: RequestActor,
    options: InventoryFilter & { kind: "users" },
  ): Promise<AccountIdentityPage<AccountIdentityUser>>;
  async function inventory(
    actor: RequestActor,
    options: InventoryFilter & { kind: "groups" },
  ): Promise<AccountIdentityPage<AccountIdentityGroup>>;
  async function inventory(actor: RequestActor, options: InventoryFilter & { kind: "users" | "groups" }) {
    await requireAdmin(actor);
    const after = cursor(options.after);
    const id = cursor(options.id);
    const name = options.name ?? null;
    if (options.provider !== "local" && options.provider !== "ipa") throw new AccountIdentityError("invalid_provider", 400);
    if (options.kind === "users") {
      return page(
        (
          await userRows(sql`u.provider = ${options.provider} AND (${after}::uuid IS NULL OR u.id > ${after}::uuid)
        AND (${id}::uuid IS NULL OR u.id = ${id}::uuid) AND (${name}::text IS NULL OR u.uid = ${name})`)
        ).map(projectUser),
      );
    }
    if (options.kind !== "groups") throw new AccountIdentityError("invalid_inventory_kind", 400);
    return page(
      await groupRows(sql`g.provider = ${options.provider} AND (${after}::uuid IS NULL OR g.id > ${after}::uuid)
      AND (${id}::uuid IS NULL OR g.id = ${id}::uuid) AND (${name}::text IS NULL OR g.name = ${name})`),
    );
  }
  const readLocalIdentity = async (input: {
    kind: "users" | "groups";
    name: string;
    identityId?: string;
  }): Promise<AccountIdentityReconciliation> => {
    if (input.kind === "users") {
      const rows = await userRows(sql`(u.provider = 'local' AND u.uid = ${input.name}) OR u.id = ${input.identityId ?? null}::uuid`);
      const expected = rows.find((row) => row.id === input.identityId);
      if (expected && (expected.provider !== "local" || expected.uid !== input.name))
        return { state: "unknown", reason: "identity_conflict" };
      const matches = rows.filter((row) => row.provider === "local" && row.uid === input.name);
      if (!matches.length) return { state: "absent" };
      if (matches.length !== 1) return { state: "unknown", reason: "invalid_response" };
      const current = projectUser(matches[0]!);
      return {
        state: "present",
        identity: {
          id: current.id,
          name: current.username,
          uidNumber: current.posix?.uidNumber ?? null,
          gidNumber: current.posix?.primaryGidNumber ?? null,
        },
        eligible: current.profile === "user",
      };
    }
    const rows = await groupRows(sql`(g.provider = 'local' AND g.name = ${input.name}) OR g.id = ${input.identityId ?? null}::uuid`);
    const expected = rows.find((row) => row.id === input.identityId);
    if (expected && (expected.provider !== "local" || expected.name !== input.name))
      return { state: "unknown", reason: "identity_conflict" };
    const matches = rows.filter((row) => row.provider === "local" && row.name === input.name);
    if (!matches.length) return { state: "absent" };
    if (matches.length !== 1) return { state: "unknown", reason: "invalid_response" };
    const current = matches[0]!;
    return {
      state: "present",
      identity: { id: current.id, name: current.name, uidNumber: null, gidNumber: current.gidNumber },
      eligible: current.gidNumber !== null,
    };
  };
  const validateLookup = (input: { kind: "users" | "groups"; name: string }) => {
    if ((input.kind !== "users" && input.kind !== "groups") || typeof input.name !== "string" || !input.name || input.name.includes("\0"))
      throw new AccountIdentityError("invalid_identity_lookup", 400);
  };
  return {
    async reconcile(
      actor: RequestActor,
      input: { kind: "users" | "groups"; provider: UserProvider; name: string; identityId?: string; signal?: AbortSignal },
    ): Promise<AccountIdentityReconciliation> {
      const { state } = await requireAdmin(actor);
      validateLookup(input);
      if (input.provider !== "local" && input.provider !== "ipa") throw new AccountIdentityError("invalid_identity_lookup", 400);
      if (input.identityId !== undefined) cursor(input.identityId);
      if (input.signal?.aborted) return { state: "unknown", reason: "provider_unavailable" };
      if (input.provider === "ipa") {
        if (!state.freeipaEnabled) return { state: "unknown", reason: "provider_disabled" };
        return upstreamIdentity(input);
      }
      const result = await readLocalIdentity(input);
      return input.signal?.aborted ? { state: "unknown", reason: "provider_unavailable" } : result;
    },
    /** Trusted application jobs only; this read does not authorize an HTTP caller or a filesystem mutation. */
    async localLifecycle(input: { kind: "users" | "groups"; identityId: string; name: string }) {
      validateLookup(input);
      cursor(input.identityId);
      const { localLinuxEnabled } = await availability();
      return { localLinuxEnabled, identity: await readLocalIdentity(input) };
    },
    async self(actor: RequestActor) {
      const { row, state } = await requireUser(actor);
      return { user: projectUser(row), availability: state };
    },
    async groups(actor: RequestActor, options: { after?: string } = {}): Promise<AccountIdentityPage<AccountIdentityGroup>> {
      const { row, state } = await requireUser(actor);
      const after = cursor(options.after);
      return page(
        await groupRows(sql`
        (${after}::uuid IS NULL OR g.id > ${after}::uuid)
        AND (g.provider = 'local' OR ${state.freeipaEnabled})
        AND ${buildMemberGroupScopeCondition({ userId: row.id, groupProvider: sql`g.provider` })}
      `),
      );
    },
    inventory,
  };
};

export const accountIdentities = createAccountIdentityService();
