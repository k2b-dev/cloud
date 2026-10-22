import { hasRole } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { sql } from "bun";
import { z } from "zod";
import { app } from "../config";
import { checkStore } from "./check";
import type { StoreConfig, StoreStatus } from "./contracts";
import { buildSetupSql, hashServicePassword } from "./setup-sql";
import { StoreSaveInput, StoreSetupInput } from "./validation";

export type StoreIdentity = Pick<AuthContext["Variables"], "actor" | "accessSubject">;
export class StoreAdminError extends Error {
  constructor(
    readonly code: "ACCESS_DENIED" | "INVALID_INPUT" | "PASSWORD_REQUIRED" | "STORE_BUSY" | "STORE_NOT_CONFIGURED",
    readonly status: 400 | 403 | 409 = 400,
  ) {
    super(code);
  }
}
export const requireStoreAdmin = (identity: StoreIdentity) => {
  const user = identity.actor.kind === "user" ? identity.actor.user : null;
  if (!user || identity.accessSubject.type !== "user" || identity.accessSubject.userId !== user.id || !hasRole(user, "admin"))
    throw new StoreAdminError("ACCESS_DENIED", 403);
};
const DEFAULT_USER = "pulse_service";
const Connection = z.object({ url: z.string(), user: z.string(), password: z.string() }).strict();
type Connection = z.infer<typeof Connection>;
const notConnected = (): Connection => ({ url: "", user: DEFAULT_USER, password: "" });
const parseConnection = (raw: string): Connection => {
  if (!raw) return notConnected();
  try {
    const parsed = Connection.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : notConnected();
  } catch {
    return notConnected();
  }
};
/** The saved connection as one tuple; a value this version cannot read counts as not set up, and saving replaces it. */
const config = async (): Promise<Connection> => parseConnection(await app.settings.get("pulse.clickhouse_connection"));
/** The stored row itself, bypassing the cache: a save never keeps a password it could not decrypt. */
const storedConfig = async (): Promise<Connection> => {
  const stored = await app.settings.read("pulse.clickhouse_connection");
  return stored.stored === "readable" ? parseConnection(stored.value) : notConnected();
};
const publicConfig = (value: Awaited<ReturnType<typeof config>>): StoreConfig => ({
  configured: Boolean(value.url && value.user && value.password),
  url: value.url,
  user: value.user,
  passwordSet: Boolean(value.password),
});

export const createStoreAdmin = ({ prefix = "pulse_", clock = () => new Date() }: { prefix?: string; clock?: () => Date } = {}) => ({
  async read(identity: StoreIdentity): Promise<StoreConfig> {
    requireStoreAdmin(identity);
    return publicConfig(await config());
  },
  async status(identity: StoreIdentity, signal?: AbortSignal): Promise<StoreStatus> {
    requireStoreAdmin(identity);
    const current = await config(),
      visible = publicConfig(current);
    return { ...visible, status: visible.configured ? await checkStore({ ...current, prefix, clock, mode: "connection", signal }) : null };
  },
  async check(identity: StoreIdentity, signal?: AbortSignal) {
    requireStoreAdmin(identity);
    const current = await config();
    if (!publicConfig(current).configured) throw new StoreAdminError("STORE_NOT_CONFIGURED", 409);
    return checkStore({ ...current, prefix, clock, mode: "full", signal });
  },
  async save(identity: StoreIdentity, input: unknown, signal?: AbortSignal): Promise<StoreStatus> {
    requireStoreAdmin(identity);
    const parsed = StoreSaveInput.safeParse(input);
    if (!parsed.success) throw new StoreAdminError("INVALID_INPUT");
    const next = parsed.data;
    return sql.begin(async (tx) => {
      // Try, never wait: a waiter would hold a pooled connection for the whole check of the save before it.
      const [lock] = await tx<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('pulse.store.settings')) AS locked`;
      if (!lock?.locked) throw new StoreAdminError("STORE_BUSY", 409);
      const current = await storedConfig();
      // The saved password goes only to the saved address and user: a new target needs it typed again,
      // so a changed address can never carry the stored secret to another host.
      const sameTarget = next.url === current.url && next.user === current.user;
      const password = next.password ?? (sameTarget ? current.password : "");
      if (!password) throw new StoreAdminError("PASSWORD_REQUIRED");
      const candidate = { ...next, password };
      const status = await checkStore({ ...candidate, prefix, clock, signal, mode: "full" });
      if (!status.ok) return { ...publicConfig(current), status };
      // One write of complete explicit admin input: readers see the old tuple or the new one, never a mix.
      await app.settings.set("pulse.clickhouse_connection", JSON.stringify(candidate satisfies Connection), { replaceUnreadable: true });
      return { ...publicConfig(candidate), status };
    });
  },
  async setupSql(identity: StoreIdentity, input: unknown) {
    requireStoreAdmin(identity);
    const parsed = StoreSetupInput.safeParse(input);
    if (!parsed.success) throw new StoreAdminError("INVALID_INPUT");
    const user = parsed.data.user ?? (await config()).user;
    const hash = await hashServicePassword(parsed.data.password);
    return { sql: buildSetupSql({ prefix, user, passwordSha256Hex: hash.sha256Hex, saltHex: hash.saltHex }) };
  },
});
export const storeAdmin = createStoreAdmin();

/** Server-only cached reader; never return this tuple through an API. */
export const storeConnection = async () => {
  const value = await config();
  return publicConfig(value).configured ? value : null;
};
export const pulseStoreConfigured = async (): Promise<boolean> => (await storeConnection()) !== null;
