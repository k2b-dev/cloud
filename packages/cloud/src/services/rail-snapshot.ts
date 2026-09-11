import { requestCacheRedis } from "./request-cache-redis";
import { type RailSnapshot, RailSnapshotSchema } from "../contracts/rail-preferences";
import type { User } from "../contracts/shared";
import { railPreferences } from "./rail-preferences";
import { railShortcuts } from "./rail-shortcuts";

// Private request metadata: never serialized into the public User contract.
const versions = new WeakMap<User, string>();
export const setRailCacheVersion = (user: User, version: unknown) => {
  if (typeof version === "string") versions.set(user, version);
};

/** TTL only bounds unused generations; freshness comes from the current identity query. */
const CACHE_TTL_SECONDS = 300;
export const createRailSnapshotReader =
  (
    load: (userId: string) => Promise<RailSnapshot>,
    cache: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<unknown> },
  ) =>
  async (user: User): Promise<RailSnapshot> => {
    const version = versions.get(user);
    if (!version) return load(user.id);
    const key = `appglobalcache:user:${user.id}:rail:v1:${version}`;
    try {
      const cached = await cache.get(key);
      if (cached !== null) {
        const parsed = RailSnapshotSchema.safeParse(JSON.parse(cached));
        if (parsed.success) return parsed.data;
      }
    } catch {
      /* Valkey is an optimization; authoritative reads still work. */
    }
    const value = await load(user.id);
    // A concurrent mutation changes the generation. A late refill remains under
    // this request's old key and cannot poison a subsequent request's snapshot.
    try {
      await cache.set(key, JSON.stringify(value));
    } catch {
      /* Retry on a later read. */
    }
    return value;
  };

export const readRailSnapshot = createRailSnapshotReader(
  async (userId) => {
    const [personal, managedShortcuts] = await Promise.all([railPreferences.get(userId), railShortcuts.forUser(userId)]);
    return { ...personal, managedShortcuts };
  },
  {
    get: async (key) => (await requestCacheRedis()).get(key),
    set: async (key, value) => (await requestCacheRedis()).set(key, value, "EX", CACHE_TTL_SECONDS),
  },
);
