/**
 * App-facing settings service. Wraps the lower-level primitives in
 * `services/settings` (get, set, getAll, remove + SETTINGS_MAP) with the
 * filtered list / validated update / reset surface the admin UIs need.
 *
 * Lives in cloud-lib because every app that has app-scoped settings needs
 * the same API to render its admin form (files, weather, etc.).
 */

import { err, fail, ok, type PageParams, type Paginated } from "@k2b/stdlib";
import { paginateItems } from "../../server/services";
import type { SettingEntry } from ".";
import * as settingsPrimitives from ".";
import { SETTINGS_MAP, validateSettingValue } from "./defaults";

/**
 * Redact secret-kind setting values before they leave the server.
 *
 * Secret values are encrypted at rest and decrypted on read for runtime use,
 * but the admin UI receives them via SSR `data-props` (visible in HTML
 * source, browser caches, devtools). For secrets we hide the actual value
 * and rely on the form's change-tracking: if the admin doesn't type a new
 * value, no PUT is sent and the stored value stays. The placeholder hint in
 * the UI signals "leave empty to keep current".
 */
const redactSecretValue = (entry: SettingEntry): SettingEntry => {
  if (entry.kind !== "secret") return entry;
  return { ...entry, value: "" };
};

export const settingsService = {
  entry: {
    list: async (config?: { pagination?: PageParams; filter?: { query?: string; group?: string }; locale?: string }): Promise<Paginated<SettingEntry>> => {
      const entries = await settingsPrimitives.getAll(config?.locale);
      const query = config?.filter?.query?.trim().toLowerCase();
      const group = config?.filter?.group?.trim().toLowerCase();

      const filtered = entries
        .filter((entry) => {
          if (group && entry.group.toLowerCase() !== group) return false;
          if (!query) return true;
          return (
            entry.key.toLowerCase().includes(query) ||
            entry.label.toLowerCase().includes(query) ||
            entry.description.toLowerCase().includes(query)
          );
        })
        .map(redactSecretValue);

      return paginateItems(filtered, config?.pagination);
    },
    update: async (config: { key: string; value: unknown }) => {
      if (!SETTINGS_MAP.has(config.key)) {
        return fail(err.badInput(`Unknown setting: ${config.key}`));
      }
      const def = SETTINGS_MAP.get(config.key)!;
      const validated = validateSettingValue(def, config.value);
      if (!validated.ok) {
        return fail(err.badInput(validated.error));
      }
      try {
        await settingsPrimitives.set(config.key, validated.value);
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("Unknown setting:")) {
          return fail(err.badInput(message));
        }
        return fail(err.internal(`Failed to update setting: ${message}`));
      }
    },
    reset: async (config: { key: string }) => {
      if (!SETTINGS_MAP.has(config.key)) {
        return fail(err.badInput(`Unknown setting: ${config.key}`));
      }
      try {
        await settingsPrimitives.remove(config.key);
        return ok(undefined);
      } catch (error) {
        return fail(err.internal(`Failed to reset setting: ${error instanceof Error ? error.message : String(error)}`));
      }
    },
  },
};

export type SettingsService = typeof settingsService;
