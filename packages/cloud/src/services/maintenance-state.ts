import type { EphemeralConfig } from "@k2b/sync";
import { lazySync } from "../_internal/process-sync";
import { type MaintenanceState, parseMaintenanceState } from "../contracts/maintenance";

/**
 * Maintenance state: one key on a Sync ephemeral of the process Sync
 * instance, next to the app registry. Core writes it; the gateway reads it
 * without Postgres or Core. Every process declares it through this config, so
 * id and owner stay identical across the fleet.
 *
 * Maintenance never ends by itself. An ephemeral needs a TTL, so the record
 * lives 7 days and the gateway renews it (`renewMaintenanceState`) while it is
 * active whenever less than half of that remains. Absent means off.
 */
export const MAINTENANCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAINTENANCE_STATE_KEY = "state";

export const MAINTENANCE_CONFIG = {
  id: "cloud-maintenance",
  owner: "cloud",
  ttlMs: MAINTENANCE_TTL_MS,
  maxEntries: 16,
  maxValueBytes: 4 * 1024,
} as const satisfies EphemeralConfig;

const store = lazySync((sync) => sync.ephemeral<unknown>(MAINTENANCE_CONFIG));

export type ObservedMaintenance = { state: MaintenanceState; updatedAt: number };

/** The current state, `null` when off. A stored record that fails validation reads as off. */
export const readMaintenanceState = async (): Promise<ObservedMaintenance | null> => {
  const snapshot = await store().snapshot({ prefix: MAINTENANCE_STATE_KEY });
  const entry = snapshot.entries.find((candidate) => candidate.key === MAINTENANCE_STATE_KEY);
  const state = entry ? parseMaintenanceState(entry.value) : null;
  return entry && state ? { state, updatedAt: entry.updatedAt.getTime() } : null;
};

export const writeMaintenanceState = async (state: MaintenanceState): Promise<void> => {
  await store().upsert({ key: MAINTENANCE_STATE_KEY, value: state });
};

export const clearMaintenanceState = async (): Promise<void> => {
  await store().delete({ key: MAINTENANCE_STATE_KEY });
};

/** Whether a record written at `updatedAt` needs its lease renewed now. */
export const maintenanceNeedsRenewal = (updatedAt: number, now = Date.now()): boolean => updatedAt + MAINTENANCE_TTL_MS / 2 <= now;

/** Republishes the current value with a fresh TTL. False when the record is gone. */
export const renewMaintenanceState = (): Promise<boolean> => store().touch({ key: MAINTENANCE_STATE_KEY });

/**
 * Follow the state until `signal` aborts: first the current value, then every
 * change. `onChange(null)` means off (deleted, expired or invalid). A failed
 * watch throws; the caller keeps its last known state and restarts.
 */
export const watchMaintenanceState = async ({
  signal,
  onChange,
}: {
  signal: AbortSignal;
  onChange: (observed: ObservedMaintenance | null) => void;
}): Promise<void> => {
  while (!signal.aborted) {
    const snapshot = await store().snapshot({ prefix: MAINTENANCE_STATE_KEY });
    const entry = snapshot.entries.find((candidate) => candidate.key === MAINTENANCE_STATE_KEY);
    const state = entry ? parseMaintenanceState(entry.value) : null;
    onChange(entry && state ? { state, updatedAt: entry.updatedAt.getTime() } : null);
    let resync = false;
    for await (const event of store().watch({ prefix: MAINTENANCE_STATE_KEY, after: snapshot.revision, signal })) {
      if (signal.aborted) return;
      if (event.type === "resync_required") {
        resync = true;
        break;
      }
      if (event.type === "upsert") {
        if (event.entry.key !== MAINTENANCE_STATE_KEY) continue;
        const next = parseMaintenanceState(event.entry.value);
        onChange(next ? { state: next, updatedAt: event.entry.updatedAt.getTime() } : null);
      } else if (event.key === MAINTENANCE_STATE_KEY) onChange(null);
    }
    if (!resync) return;
  }
};
