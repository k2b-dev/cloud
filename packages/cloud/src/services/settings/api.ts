/**
 * Typed async settings API.
 *
 * Two surfaces are exposed:
 *
 *  1. `app.settings` — created by `defineApp`, typed against that app's own
 *     declared settings (plus any core settings since core's snapshot is
 *     loaded into every container). Available on the AppDefinition return value.
 *
 *  2. `coreSettings` — for cloud-lib internal services that don't have an
 *     `app` reference (e.g. `services/notifications/email.ts`,
 *     `services/weather/forecast.ts`, OpenAPI middleware, cron callbacks).
 *     Loosely typed (caller provides the value type via the `T` generic).
 *
 * Backend: value reads use cache-aside via `store.ts` (Redis 5min TTL + DB
 * fallback); stored-state reads use Postgres. All functions are async — sync
 * render-time access uses the per-request snapshot
 * exposed via `c.get("settings")`.
 */

import type { AppSettingsMap, KindToType } from "../../contracts/settings-types";
import { deleteKey, readKey, readKeyState, type StoredSettingState, writeKey } from "./store";

/**
 * Per-app typed settings API. Keys constrained to those declared in the
 * app's `defineApp({ settings: ... })` block.
 */
export interface SettingsAPI<F extends Record<string, unknown>> {
  get<K extends keyof F & string>(key: K): Promise<F[K]>;
  read<K extends keyof F & string>(key: K): Promise<{ value: F[K]; stored: StoredSettingState }>;
  set<K extends keyof F & string>(key: K, value: F[K], options?: { replaceUnreadable?: boolean }): Promise<void>;
  remove<K extends keyof F & string>(key: K): Promise<void>;
}

/**
 * Build a typed SettingsAPI for a given AppSettingsMap.
 *
 * The runtime is identical for every app (delegates to store.ts); the typing
 * is purely a TS construct that constrains keys/values to what was declared.
 */
export const createSettingsAPI = <S extends AppSettingsMap>(): SettingsAPI<{
  [K in keyof S]: KindToType<S[K]["kind"]>;
}> => ({
  get: async (key) => readKey(key) as never,
  read: async (key) => readKeyState(key) as never,
  set: async (key, value, options) => writeKey(key, value, undefined, options),
  remove: async (key) => deleteKey(key),
});

/**
 * cloud-lib internal services and other apps use `coreSettings` for any
 * setting access outside of a per-request context. Loose-typed (the caller
 * specifies the expected value type via the `T` generic) — apps that need
 * tight typing for their OWN settings use `app.settings.get/set` instead.
 *
 * Usage:
 *   await coreSettings.get<string>("app.name");          // string
 *   await coreSettings.set("freeipa.enable", true);       // value type free
 */
export const coreSettings = {
  get: <T = unknown>(key: string): Promise<T> => readKey(key) as Promise<T>,
  read: <T = unknown>(key: string): Promise<{ value: T; stored: StoredSettingState }> =>
    readKeyState(key) as Promise<{ value: T; stored: StoredSettingState }>,
  set: (key: string, value: unknown, options?: { replaceUnreadable?: boolean }): Promise<void> => writeKey(key, value, undefined, options),
  remove: (key: string): Promise<void> => deleteKey(key),
};
