/**
 * Per-request settings snapshot.
 *
 * Loads every known setting via `bulkRead` (one Redis MGET + DB fallback for
 * misses; secret cache entries stay encrypted) and builds a frozen nested object keyed by dotted-path segments.
 *
 * Used by the middleware that runs at request start (see `define-app.ts`).
 * Exposed on the Hono context as `c.get("settings")` — typed per-app via
 * `AppContext<typeof app>`.
 *
 * The snapshot is read-only and stable for the duration of one request:
 * later writes (in this or other containers) do not mutate this snapshot.
 * If a long-running handler needs fresh values, it should use the typed
 * async API (`app.settings.get(key)`) instead.
 */

import { allKnownKeys, bulkRead } from "./store";

/** Build a frozen nested object from the registered settings. */
export const loadSnapshot = async (): Promise<Readonly<Record<string, unknown>>> => {
  const flat = await bulkRead(allKnownKeys());

  const tree: Record<string, unknown> = {};
  for (const [key, value] of flat) {
    const parts = key.split(".");
    let cursor = tree;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      const existing = cursor[part];
      if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]!] = value;
  }

  return deepFreeze(tree);
};

const deepFreeze = <T>(obj: T): Readonly<T> => {
  if (obj === null || typeof obj !== "object") return obj;
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
};
