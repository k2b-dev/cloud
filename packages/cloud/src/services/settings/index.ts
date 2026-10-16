/**
 * Settings service — runtime-configurable settings backed by Postgres.
 *
 * Resolution order: DB value -> env fallback -> code default.
 *
 * Custom DB values are encrypted at rest using APP_SECRET. All read/write
 * goes through the Redis cache-aside layer in `./store.ts` (5-minute TTL).
 * `loadCache()` runs once at boot to normalize legacy rows and bootstrap
 * env-backed entries into Postgres. Startup never replaces an existing row;
 * env bootstrap only fills missing keys.
 */

import { redis, sql } from "bun";
import { decryptValue, encryptValue, getAppSecret } from "./crypto";
import { resolveSettingPresentation, SETTINGS, SETTINGS_MAP, type SettingDef, validateSettingValue } from "./defaults";
import { bulkRead, deleteKey, readKey, writeKey } from "./store";

type SqlClient = typeof sql;

type StoredRow = { key: string; value: string };
type PendingRow = { value: unknown; originalCiphertext: string };
type NormalizationStats = {
  encryptedLoaded: number;
  normalizedUpdated: number;
  envBootstrapped: number;
  undecryptable: number;
  invalidSkipped: number;
};

const REDIS_KEY = (key: string) => `settings:${key}`;

const isEqual = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const resolveEnvValue = (def: SettingDef | undefined, mode: "fallback" | "bootstrap"): unknown => {
  const raw = mode === "fallback" ? def?.envFallback?.() : def?.envBootstrap?.();
  if (!def || raw === undefined) return undefined;

  const validated = validateSettingValue(def, raw);
  if (!validated.ok) {
    console.warn(`[settings] ignoring invalid ${mode} value for "${def.key}": ${validated.error}`);
    return undefined;
  }

  return validated.value;
};

const shouldBootstrapValue = (def: SettingDef, value: unknown): boolean => {
  if (value === undefined || value === null) return false;

  switch (def.kind) {
    case "boolean":
      return value === true;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string_list":
    case "number_list":
      return Array.isArray(value) && value.length > 0;
    default:
      return typeof value === "string" && value.trim().length > 0;
  }
};

const normalizeStoredEntries = async (): Promise<{
  rows: Array<{ key: string; value: unknown }>;
  storedKeys: Set<string>;
  stats: NormalizationStats;
}> => {
  const rows = await sql<StoredRow[]>`SELECT key, value FROM settings.entries`;
  const storedKeys = new Set(rows.map((row) => row.key));
  const stats: NormalizationStats = {
    encryptedLoaded: 0,
    normalizedUpdated: 0,
    envBootstrapped: 0,
    undecryptable: 0,
    invalidSkipped: 0,
  };
  const pendingRows = new Map<string, PendingRow>();

  for (const row of rows) {
    try {
      const value = await decryptValue(row.value);
      pendingRows.set(row.key, { value, originalCiphertext: row.value });
      stats.encryptedLoaded += 1;
    } catch {
      // An unreadable value is not a missing value (#1295). Usually this
      // process runs with another APP_SECRET than the writer; applications
      // with the right key still read this row. Keep its key in `storedKeys`
      // so env bootstrap never replaces it, and never log the value.
      console.warn(
        `[settings] cannot decrypt stored value for "${row.key}" with this APP_SECRET; keeping the row unchanged, reads use the environment fallback or default`,
      );
      stats.undecryptable += 1;
    }
  }

  const normalized: Array<{ key: string; value: unknown }> = [];

  for (const [key, row] of pendingRows.entries()) {
    const def = SETTINGS_MAP.get(key);
    if (!def) {
      console.warn(`[settings] skipping unknown stored key "${key}"`);
      stats.invalidSkipped += 1;
      continue;
    }

    const validated = validateSettingValue(def, row.value);
    if (!validated.ok) {
      console.warn(`[settings] skipping invalid value for "${key}": ${validated.error}`);
      stats.invalidSkipped += 1;
      continue;
    }

    normalized.push({ key, value: validated.value });

    if (!isEqual(row.value, validated.value)) {
      const encryptedValue = await encryptValue(validated.value);
      const updated = await sql<{ key: string }[]>`
        UPDATE settings.entries SET value = ${encryptedValue}, updated_at = now()
        WHERE key = ${key} AND value = ${row.originalCiphertext}
        RETURNING key
      `;
      if (updated.length > 0) {
        await redis.del(REDIS_KEY(key));
        stats.normalizedUpdated += 1;
      }
    }
  }

  return { rows: normalized, storedKeys, stats };
};

const bootstrapEnvBackedEntries = async (config: {
  rows: Array<{ key: string; value: unknown }>;
  storedKeys: Set<string>;
  stats: NormalizationStats;
}): Promise<Array<{ key: string; value: unknown }>> => {
  const rowsByKey = new Map(config.rows.map((row) => [row.key, row.value]));

  for (const def of SETTINGS) {
    // Existing rows block bootstrap even if unreadable, unknown, or invalid.
    if (config.storedKeys.has(def.key)) continue;

    const envValue = resolveEnvValue(def, "bootstrap");
    if (!shouldBootstrapValue(def, envValue)) continue;

    const encryptedValue = await encryptValue(envValue);
    const inserted = await sql<{ key: string }[]>`
      INSERT INTO settings.entries (key, value, updated_at)
      VALUES (${def.key}, ${encryptedValue}, now())
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    `;
    if (inserted.length === 0) continue;

    await redis.del(REDIS_KEY(def.key));
    rowsByKey.set(def.key, envValue);
    config.stats.envBootstrapped += 1;
  }

  return [...rowsByKey.entries()].map(([key, value]) => ({ key, value }));
};

/**
 * Boot-time normalization + env-bootstrap. Runs once at startup. Does NOT
 * populate any in-process cache — every read goes through Redis cache-aside
 * (`store.ts`) at request time.
 */
export async function loadCache(): Promise<void> {
  getAppSecret();
  const { rows, storedKeys, stats } = await normalizeStoredEntries();
  const bootstrappedRows = await bootstrapEnvBackedEntries({ rows, storedKeys, stats });

  console.log(
    `[settings] loaded ${bootstrappedRows.length} custom setting(s) (${stats.encryptedLoaded} encrypted, ${stats.normalizedUpdated} normalized, ${stats.envBootstrapped} env-bootstrapped, ${stats.undecryptable} undecryptable, ${stats.invalidSkipped} skipped)`,
  );
}

/**
 * Read a setting via the Redis cache-aside layer (always within Redis-TTL
 * fresh). Resolution: Redis cache → Postgres → env-fallback → code default.
 */
export async function get<T = unknown>(key: string): Promise<T> {
  return readKey(key) as Promise<T>;
}

/**
 * Write a setting. Pass `db` to run inside a caller's transaction — then the
 * caller must also call `invalidateSettingsCache` once it commits.
 */
export async function set(key: string, value: unknown, db?: SqlClient): Promise<void> {
  await writeKey(key, value, db);
}

export async function remove(key: string, db?: SqlClient): Promise<void> {
  await deleteKey(key, db);
}

import type { SettingEntry } from "../../contracts/shared";

export type { SettingEntry } from "../../contracts/shared";
export { invalidateSettingsCache } from "./store";

export async function getAll(locale?: string): Promise<SettingEntry[]> {
  // Determine which keys have a custom row in Postgres (vs. falling back to
  // env / code default). One indexed scan, then bulk-read all values.
  const customRows = await sql<{ key: string }[]>`SELECT key FROM settings.entries`;
  const customKeys = new Set(customRows.map((row) => row.key));

  const allKeys = SETTINGS.map((def) => def.key);
  const values = await bulkRead(allKeys);

  return SETTINGS.map((def) => {
    const presentation = resolveSettingPresentation(def, locale);
    const isCustom = customKeys.has(def.key);
    const envFallback = resolveEnvValue(def, "fallback");
    const resetValue = envFallback ?? def.default;

    return {
      key: def.key,
      label: presentation.label,
      kind: def.kind,
      description: presentation.description ?? "",
      placeholder: presentation.placeholder,
      group: def.group,
      value: values.get(def.key),
      default: def.default,
      resetValue: def.kind === "secret" ? "" : resetValue,
      valueSource: isCustom ? "custom" : envFallback === undefined ? "default" : "env",
      resetValueSource: envFallback === undefined ? "default" : "env",
      isCustom,
      templateVars: "templateVars" in def ? def.templateVars : undefined,
      options: presentation.options,
      min: "min" in def ? def.min : undefined,
      max: "max" in def ? def.max : undefined,
    };
  });
}
