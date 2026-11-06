import { sql } from "@k2b/cloud";
import { audit } from "@k2b/cloud/services";
import { invalidateSettingsCache, set } from "@k2b/cloud/services/settings";
import { app } from "../config";
import type { PulsePolicy, PulsePolicyUpdate } from "../store/admin-contracts";
import { PulsePolicySchema, PulsePolicyUpdateSchema } from "../store/admin-schemas";
import { requireStoreAdmin, type StoreIdentity } from "../store/service";

export const readBasePolicy = async (): Promise<PulsePolicy> => {
  const [
    baseCreation,
    maxBases,
    maxRawRetentionDays,
    defaultProfile,
    valuesPerMinute,
    bytesPerMinute,
    storageBytes,
    maxSeries,
    maxEventKinds,
    maxStateKeys,
    queriesPerHour,
  ] = await Promise.all([
    app.settings.get("pulse.base_creation"),
    app.settings.get("pulse.max_bases"),
    app.settings.get("pulse.max_raw_retention_days"),
    app.settings.get("pulse.default_profile"),
    app.settings.get("pulse.default_values_per_minute"),
    app.settings.get("pulse.default_bytes_per_minute"),
    app.settings.get("pulse.default_storage_bytes"),
    app.settings.get("pulse.default_max_series"),
    app.settings.get("pulse.default_max_event_kinds"),
    app.settings.get("pulse.default_max_state_keys"),
    app.settings.get("pulse.default_queries_per_hour"),
  ]);
  return PulsePolicySchema.parse({
    baseCreation,
    maxBases,
    maxRawRetentionDays,
    defaultProfile,
    defaultLimits: { queriesPerHour, valuesPerMinute, bytesPerMinute, storageBytes, maxSeries, maxEventKinds, maxStateKeys },
  });
};
export const getPolicy = async (identity: StoreIdentity) => {
  requireStoreAdmin(identity);
  return readBasePolicy();
};
export const setPolicy = async (identity: StoreIdentity, input: PulsePolicyUpdate) => {
  requireStoreAdmin(identity);
  const update = PulsePolicyUpdateSchema.parse(input);
  const updates = [
    ["pulse.base_creation", update.baseCreation],
    ["pulse.max_bases", update.maxBases],
    ["pulse.max_raw_retention_days", update.maxRawRetentionDays],
    ["pulse.default_profile", update.defaultProfile],
    ["pulse.default_queries_per_hour", update.defaultLimits?.queriesPerHour],
    ["pulse.default_values_per_minute", update.defaultLimits?.valuesPerMinute],
    ["pulse.default_bytes_per_minute", update.defaultLimits?.bytesPerMinute],
    ["pulse.default_storage_bytes", update.defaultLimits?.storageBytes],
    ["pulse.default_max_series", update.defaultLimits?.maxSeries],
    ["pulse.default_max_event_kinds", update.defaultLimits?.maxEventKinds],
    ["pulse.default_max_state_keys", update.defaultLimits?.maxStateKeys],
  ].filter(([, value]) => value !== undefined);
  await sql.begin(async (tx) => {
    for (const [key, value] of updates) await set(String(key), value, tx);
    await audit.record(
      {
        action: "pulse.policy.configure",
        outcome: "allowed",
        actor: { userId: identity.accessSubject.type === "user" ? identity.accessSubject.userId : null },
        target: { type: "settings", id: "pulse" },
        metadata: { keys: updates.map(([key]) => key) },
      },
      tx,
    );
  });
  await invalidateSettingsCache(updates.map(([key]) => String(key)));
  return readBasePolicy();
};
