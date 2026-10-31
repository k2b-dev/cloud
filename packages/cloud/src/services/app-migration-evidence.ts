import type { SQL } from "bun";
import { sql } from "../runtime/clients";

export type LegacyAppPath = "bearer" | "broker-secret";
/** One durable row per legacy path, shared by all Core replicas. Never stores credentials. */
export const recordLegacyAppUse = async (path: LegacyAppPath, db: SQL = sql): Promise<void> => {
  await db`INSERT INTO auth.app_migration_legacy (path, last_used_at) VALUES (${path}, clock_timestamp())
    ON CONFLICT (path) DO UPDATE SET last_used_at = GREATEST(auth.app_migration_legacy.last_used_at, EXCLUDED.last_used_at)`;
};
export const beginAppMigrationObservation = async (db: SQL = sql) => {
  const [row] = await db<{ started_at: Date }[]>`INSERT INTO auth.app_migration_observation (singleton, started_at)
    VALUES (true, clock_timestamp()) ON CONFLICT (singleton) DO UPDATE SET started_at = EXCLUDED.started_at RETURNING started_at`;
  if (!row) throw new Error("Observation did not start");
  return { startedAt: row.started_at.toISOString() };
};
export const readAppMigrationObservation = async (windowSeconds: number | undefined, db: SQL = sql) => {
  const [row] = await db<{ started_at: Date | null; last_used_at: Date | null; observed_at: Date }[]>`
    SELECT (SELECT started_at FROM auth.app_migration_observation WHERE singleton) AS started_at,
      (SELECT max(last_used_at) FROM auth.app_migration_legacy) AS last_used_at, clock_timestamp() AS observed_at`;
  if (!row) throw new Error("Observation unavailable");
  return evaluateLegacyObservation(row.started_at, row.last_used_at, row.observed_at, windowSeconds);
};
export const evaluateLegacyObservation = (startedAt: Date | null, lastUsedAt: Date | null, observedAt: Date, windowSeconds?: number) => {
  const cleanSince = Math.max(startedAt?.getTime() ?? Infinity, lastUsedAt?.getTime() ?? 0);
  return {
    startedAt: startedAt?.toISOString() ?? null,
    lastLegacyUseAt: lastUsedAt?.toISOString() ?? null,
    observedAt: observedAt.toISOString(),
    windowSeconds: windowSeconds ?? null,
    complete: windowSeconds !== undefined && observedAt.getTime() - cleanSince >= windowSeconds * 1000,
  };
};
export const recordAppMigrationProbe = async (
  input: { keyId: string; scope: "identity:invoke" | "oauth:issue"; nonce: string },
  db: SQL = sql,
): Promise<void> => {
  await db`INSERT INTO auth.app_migration_probes (key_id, scope, nonce) VALUES (${input.keyId}::uuid, ${input.scope}, ${input.nonce}::uuid)
    ON CONFLICT (key_id, scope) DO UPDATE SET nonce = EXCLUDED.nonce`;
};
