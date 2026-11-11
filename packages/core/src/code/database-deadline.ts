import { sql } from "@k2b/cloud";
import type { SQL } from "bun";
import { codeSettings } from "./settings";

/** One period owns both the reminder window and the minimum visible advance notice. */
export const DATABASE_EXPIRY_REMINDER_DAYS = 7;
export const DATABASE_EXPIRY_NOTICE_MS = DATABASE_EXPIRY_REMINDER_DAYS * 86_400_000;
export const databaseDeletionDate = (since: Date, days: number, shownAt: Date = since): Date | null =>
  days === 0 ? null : new Date(Math.max(since.getTime() + days * 86_400_000, shownAt.getTime() + DATABASE_EXPIRY_NOTICE_MS));

/** Destructive maintenance never falls back over an unreadable operator setting. */
export async function readUnusedDatabaseDays() {
  const state = await codeSettings.read("core.code.database_unused_days");
  if (state.stored === "unreadable") throw new Error("code_database_retention_setting_unreadable");
  return state.value;
}
export type DatabaseRetentionPolicy = { revision: string; days: number };
/** Settings writes bump this row in their own transaction. The shared lock fences even
 * absent/reset settings and an off/on cycle between sweeps, without locking every database.
 */
export async function lockDatabaseRetentionPolicy(tx: SQL): Promise<DatabaseRetentionPolicy> {
  const [policy] = await tx<{ revision: string }[]>`SELECT revision::text FROM code.database_retention_policy WHERE singleton FOR SHARE`;
  if (!policy) throw new Error("code_database_retention_policy_missing");
  return { revision: policy.revision, days: await readUnusedDatabaseDays() };
}

/** Persist before exposing the date. A setting change starts the same advance notice for
 * every owner kind, even if no notification recipient exists or the scheduler was offline.
 */
export async function refreshDatabaseDeadline(tx: SQL, codeId: string, now: Date, policy: DatabaseRetentionPolicy) {
  const [row] = await tx<{ unused_since: Date }[]>`SELECT unused_since FROM code.databases
    WHERE code_id=${codeId} AND unused_since IS NOT NULL
      AND (unused_policy_revision IS DISTINCT FROM ${policy.revision}::bigint OR unused_days IS DISTINCT FROM ${policy.days}
        OR (${policy.days}>0 AND unused_shown_at IS NULL)) FOR UPDATE`;
  if (!row) return;
  await tx`UPDATE code.databases SET unused_policy_revision=${policy.revision}::bigint, unused_days=${policy.days},
      unused_shown_at=${policy.days ? now : null}, unused_delete_at=${databaseDeletionDate(row.unused_since, policy.days, now)},
      unused_notice_key=NULL WHERE code_id=${codeId}`;
}

export async function readDatabaseDeadline(codeId: string, now: Date = new Date()) {
  return sql.begin(async (tx) => {
    const policy = await lockDatabaseRetentionPolicy(tx);
    await refreshDatabaseDeadline(tx, codeId, now, policy);
    const [row] = await tx<{ unused_since: Date; unused_delete_at: Date | null; namespace: string }[]>`
      SELECT unused_since,unused_delete_at,namespace FROM code.databases WHERE code_id=${codeId} AND unused_since IS NOT NULL`;
    return row
      ? { since: row.unused_since.toISOString(), deleteAt: row.unused_delete_at?.toISOString() ?? null, namespace: row.namespace }
      : undefined;
  });
}
