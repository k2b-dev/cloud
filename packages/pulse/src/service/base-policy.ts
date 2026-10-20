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
  ]);
  return PulsePolicySchema.parse({
    baseCreation,
    maxBases,
    maxRawRetentionDays,
    defaultProfile,
    defaultLimits: { valuesPerMinute, bytesPerMinute, storageBytes, maxSeries, maxEventKinds, maxStateKeys },
  });
};
export const getPolicy = async (identity: StoreIdentity) => {
  requireStoreAdmin(identity);
  return readBasePolicy();
};
export const setPolicy = async (identity: StoreIdentity, input: PulsePolicyUpdate) => {
  requireStoreAdmin(identity);
  const update = PulsePolicyUpdateSchema.parse(input);
  // Each setting is independently valid; omitted settings and unreadable values are never overwritten.
  if (update.baseCreation !== undefined) await app.settings.set("pulse.base_creation", update.baseCreation);
  if (update.maxBases !== undefined) await app.settings.set("pulse.max_bases", update.maxBases);
  if (update.maxRawRetentionDays !== undefined) await app.settings.set("pulse.max_raw_retention_days", update.maxRawRetentionDays);
  if (update.defaultProfile !== undefined) await app.settings.set("pulse.default_profile", update.defaultProfile);
  const limits = update.defaultLimits;
  if (limits?.valuesPerMinute !== undefined) await app.settings.set("pulse.default_values_per_minute", limits.valuesPerMinute);
  if (limits?.bytesPerMinute !== undefined) await app.settings.set("pulse.default_bytes_per_minute", limits.bytesPerMinute);
  if (limits?.storageBytes !== undefined) await app.settings.set("pulse.default_storage_bytes", limits.storageBytes);
  if (limits?.maxSeries !== undefined) await app.settings.set("pulse.default_max_series", limits.maxSeries);
  if (limits?.maxEventKinds !== undefined) await app.settings.set("pulse.default_max_event_kinds", limits.maxEventKinds);
  if (limits?.maxStateKeys !== undefined) await app.settings.set("pulse.default_max_state_keys", limits.maxStateKeys);
  return readBasePolicy();
};
