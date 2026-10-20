/**
 * Settings store — Redis cache-aside read/write primitives.
 *
 * Pattern: each key is cached in Redis with a 5-minute TTL. Value reads try Redis
 * first, fall back to DB on miss, and populate Redis. Writes update DB and
 * delete the Redis key (next reader repopulates with fresh DB state).
 *
 * This achieves cross-container coherence without polling or pubsub: a write
 * in container A invalidates the shared Redis cache; container B's next read
 * hits Redis (miss after del), goes to DB, sees the new value, repopulates.
 *
 * Reads/writes here are async — sync callers should use the per-request
 * snapshot exposed via `c.get("settings")` (built by snapshot.ts middleware).
 */

import { sql } from "bun";
import { HTTPException } from "hono/http-exception";
import { hasRole, type User } from "../../contracts/shared";
import { claimCacheFill, completeCacheFill, MISSING_SETTING } from "../cache-fill";
import { stripImageDataUrlMetadata } from "../image-metadata";
import { toPgTextArray } from "../postgres";
import { requestCacheRedis } from "../request-cache-redis";
import { decryptValue, encryptValue } from "./crypto";
import { assertGeoBudgetPair } from "./geo-budget";
import { SETTINGS, SETTINGS_MAP, type SettingDef, validateSettingValue } from "./defaults";

const REDIS_KEY = (k: string) => `settings:${k}`;

type SqlClient = typeof sql;

export type StoredSettingState = "none" | "readable" | "unreadable";
export type SettingRead = { value: unknown; stored: StoredSettingState };

export class SettingUnreadableError extends HTTPException {
  readonly code = "setting_unreadable" as const;

  constructor(readonly key: string) {
    const message = `The stored value of setting "${key}" cannot be read by this application. Replace it with a new value or reset it to the default.`;
    super(409, { message, res: Response.json({ code: "setting_unreadable", message }, { status: 409 }) });
    this.name = "SettingUnreadableError";
  }
}

/**
 * Forget cached values so every container re-reads on next access.
 *
 * Separate from the write because ordering matters: dropping the cache while a
 * transaction is still open lets another container miss, read the pre-commit
 * row and cache *that* for the full TTL. Callers writing inside a transaction
 * therefore invalidate after it commits.
 */
export const invalidateSettingsCache = async (keys: readonly string[]): Promise<void> => {
  if (keys.length > 0) await (await requestCacheRedis()).del(...keys.map(REDIS_KEY));
};
const REDIS_TTL_SEC = 300;

type StoredRow = { key: string; value: string };
type LegacyStoredRow = { key: string; value: string; updated_at: Date | string | null };

export type LegacySettingRow = {
  key: string;
  updatedAt: string | null;
  decryptable: boolean;
};

/**
 * Resolve the env-fallback or default value for a key whose DB row is missing
 * or invalid. Mirrors the existing `resolve()` logic in services/settings/index.ts
 * but takes a SettingDef directly (no global state).
 */
const resolveFallback = (def: SettingDef | undefined): unknown => {
  if (!def) return undefined;
  const raw = def.envFallback?.();
  if (raw !== undefined) {
    const validated = validateSettingValue(def, raw);
    if (validated.ok) return validated.value;
  }
  return def.default;
};

/**
 * Read a single setting key. Tries Redis first, falls back to DB.
 * On DB hit, populates Redis with TTL. On miss, returns env-fallback or default.
 */
export const readKey = async (key: string): Promise<unknown> => (await bulkRead([key])).get(key);

export const readKeyState = async (key: string): Promise<SettingRead> => {
  const state = (await readStates([key])).get(key);
  if (!state) throw new Error(`Missing read state for setting "${key}"`);
  return state;
};

/** One warm MGET; missing rows are cached independently of local env/defaults. */
export const bulkRead = async (keys: readonly string[]): Promise<Map<string, unknown>> => {
  const result = new Map<string, unknown>();
  if (keys.length === 0) return result;
  let cached: Array<string | null>;
  try {
    cached = await (await requestCacheRedis()).mget(...keys.map(REDIS_KEY));
  } catch {
    cached = keys.map(() => null);
  }
  const missing: string[] = [];
  const observed = new Map(keys.map((key, i) => [key, cached[i] ?? null]));
  const fills = new Map<string, string | null>();
  for (const [i, key] of keys.entries()) {
    const value = cached[i] ?? null;
    if (value === MISSING_SETTING) {
      result.set(key, resolveFallback(SETTINGS_MAP.get(key)));
      continue;
    }
    if (value !== null) {
      try {
        result.set(key, JSON.parse(value));
        continue;
      } catch {
        /* An old/corrupt value or another reader's fill lease. */
      }
    }
    missing.push(key);
  }
  await Promise.all(
    missing.map(async (key) => {
      fills.set(key, await claimCacheFill(REDIS_KEY(key), observed.get(key) ?? null));
    }),
  );
  if (missing.length > 0) {
    const rows = await sql<StoredRow[]>`SELECT key, value FROM settings.entries WHERE key = ANY(${toPgTextArray(missing)}::text[])`;
    const byKey = new Map(rows.map((row) => [row.key, row]));
    await Promise.all(
      missing.map(async (key) => {
        const row = byKey.get(key);
        if (!row) {
          await completeCacheFill(REDIS_KEY(key), fills.get(key) ?? null, MISSING_SETTING, REDIS_TTL_SEC);
          return;
        }
        try {
          const value = await decryptValue(row.value);
          const def = SETTINGS_MAP.get(key);
          const validated = def ? validateSettingValue(def, value) : { ok: true as const, value };
          if (!validated.ok) return;
          result.set(key, validated.value);
          await completeCacheFill(REDIS_KEY(key), fills.get(key) ?? null, JSON.stringify(validated.value), REDIS_TTL_SEC);
        } catch {
          /* Preserve legacy undecryptable-row fallback behavior. */
        }
      }),
    );
  }
  for (const key of keys) if (!result.has(key)) result.set(key, resolveFallback(SETTINGS_MAP.get(key)));
  return result;
};

/**
 * Stored state is per process (APP_SECRET), but the plaintext cache is shared.
 * State reads go directly to Postgres without reading or filling the cache;
 * value reads (`get`, snapshot) keep using the cache.
 */
export const readStates = async (keys: readonly string[]): Promise<Map<string, SettingRead>> => {
  const result = new Map<string, SettingRead>();
  if (keys.length === 0) return result;
  const rows = await sql<StoredRow[]>`SELECT key, value FROM settings.entries WHERE key = ANY(${toPgTextArray([...keys])}::text[])`;
  const byKey = new Map(rows.map((row) => [row.key, row]));
  for (const key of keys) {
    const row = byKey.get(key);
    const def = SETTINGS_MAP.get(key);
    result.set(key, { stored: row ? "unreadable" : "none", value: resolveFallback(def) });
    if (!row) continue;
    try {
      const value = await decryptValue(row.value);
      const validated = def ? validateSettingValue(def, value) : { ok: true as const, value };
      if (validated.ok) result.set(key, { stored: "readable", value: validated.value });
    } catch {
      // Keep this process's fallback without changing the stored row or cache.
    }
  }
  return result;
};

/**
 * Get every known setting key (across all registered defs).
 * Used by snapshot loader to determine what to bulk-read.
 */
export const allKnownKeys = (): string[] => SETTINGS.map((d) => d.key);

// Retain the prior SMTP configuration for one release so operators can roll back.
const retainedLegacyKeys = ["smtp_host", "smtp_port", "from", "user", "password"].map((key) => `mail.noreply.${key}`);

const knownKeysWith = (extraKnownKeys: readonly string[]) =>
  Array.from(new Set([...allKnownKeys(), ...retainedLegacyKeys, ...extraKnownKeys]));

export const listLegacyKeys = async (extraKnownKeys: readonly string[] = []): Promise<LegacySettingRow[]> => {
  const knownKeys = knownKeysWith(extraKnownKeys);
  const rows = await sql<LegacyStoredRow[]>`
    SELECT key, value, updated_at
    FROM settings.entries
    WHERE NOT (key = ANY(${toPgTextArray(knownKeys)}::text[]))
    ORDER BY updated_at DESC NULLS LAST, key ASC
  `;

  const legacy: LegacySettingRow[] = [];
  for (const row of rows) {
    let decryptable = true;
    try {
      await decryptValue(row.value);
    } catch {
      decryptable = false;
    }
    legacy.push({
      key: row.key,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      decryptable,
    });
  }
  return legacy;
};

export const deleteLegacyKeys = async (extraKnownKeys: readonly string[] = []): Promise<{ deleted: string[] }> => {
  const knownKeys = knownKeysWith(extraKnownKeys);
  const rows = await sql<{ key: string }[]>`
    DELETE FROM settings.entries
    WHERE NOT (key = ANY(${toPgTextArray(knownKeys)}::text[]))
    RETURNING key
  `;
  const deleted = rows.map((row) => row.key);
  if (deleted.length > 0) await (await requestCacheRedis()).del(...deleted.map(REDIS_KEY));
  return { deleted };
};

/**
 * Encrypt the value, upsert the DB row, invalidate the Redis key.
 *
 * Validate new values and refuse to overwrite unreadable stored rows unless
 * the caller explicitly replaces them. The row check and write share a transaction.
 * Lock with a no-op UPDATE so ROW EXCLUSIVE is acquired before the row lock,
 * preserving lock order with table-level SHARE locks (#1303 review).
 * A caller passing `db` owns geo budget pair validation before mutations and
 * cache invalidation after commit.
 */
export const writeKey = async (key: string, value: unknown, db?: SqlClient, options?: { replaceUnreadable?: boolean }): Promise<void> => {
  const def = SETTINGS_MAP.get(key);
  if (!def) throw new Error(`Unknown setting: ${key}`);
  const validated = validateSettingValue(def, value);
  if (!validated.ok) throw new Error(validated.error);

  const storedValue =
    def.kind === "image" && typeof validated.value === "string" ? stripImageDataUrlMetadata(validated.value) : validated.value;
  const encrypted = await encryptValue(storedValue);
  const write = async (tx: SqlClient) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      let [row] = await tx<{ value: string }[]>`UPDATE settings.entries SET value = value WHERE key = ${key} RETURNING value`;
      if (!row) {
        const inserted = await tx<{ key: string }[]>`
          INSERT INTO settings.entries (key, value, updated_at)
          VALUES (${key}, ${encrypted}, now())
          ON CONFLICT (key) DO NOTHING RETURNING key
        `;
        if (inserted.length > 0) return;
        // A concurrent insert can win after the missing-row read; lock and check its value before updating.
        [row] = await tx<{ value: string }[]>`UPDATE settings.entries SET value = value WHERE key = ${key} RETURNING value`;
        if (!row) continue;
      }
      if (options?.replaceUnreadable !== true) {
        let readable = false;
        try {
          readable = validateSettingValue(def, await decryptValue(row.value)).ok;
        } catch {
          // Only the key is exposed by the recovery error.
        }
        if (!readable) throw new SettingUnreadableError(key);
      }
      await tx`
        UPDATE settings.entries SET value = ${encrypted}, updated_at = now() WHERE key = ${key}
      `;
      return;
    }
    throw new Error(`Could not write setting "${key}" after 3 attempts`);
  };
  if (db) await write(db);
  else
    await sql.begin(async (tx) => {
      await assertGeoBudgetPair(tx, { [key]: validated.value }, []);
      await write(tx);
    });

  // Passing a transaction means the caller owns invalidation, because the row
  // is not visible to anyone else until they commit.
  if (!db) await invalidateSettingsCache([key]);
};

/** Delete the DB row and invalidate Redis. With `db`, the caller owns geo budget pair validation and post-commit invalidation. */
export const deleteKey = async (key: string, db?: SqlClient): Promise<void> => {
  const remove = async (tx: SqlClient) => {
    await tx`DELETE FROM settings.entries WHERE key = ${key}`;
  };
  if (db) await remove(db);
  else
    await sql.begin(async (tx) => {
      await assertGeoBudgetPair(tx, {}, [key]);
      await remove(tx);
    });
  if (!db) await invalidateSettingsCache([key]);
};

/** Clear only registered settings, never sessions, signing keys or rate limits. */
export const invalidateSettingsCacheForAdmin = async (actor: User | undefined, extraKnownKeys: readonly string[] = []): Promise<void> => {
  if (!actor || !hasRole(actor, "admin")) throw new HTTPException(403, { message: "Administrator access required" });
  await invalidateSettingsCache(knownKeysWith(extraKnownKeys));
};
