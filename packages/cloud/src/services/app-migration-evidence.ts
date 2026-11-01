import { err, fail, ok } from "@k2b/stdlib";
import type { SQL } from "bun";
import { APP_INSTANCE_PREFIX, appInstanceRegistry } from "../_internal/registry";
import type { User } from "../contracts/shared";
import { sql } from "../runtime/clients";
import { audit } from "./audit";

export type LegacyAppPath = "bearer" | "broker-secret";
// A successful write covers the next five seconds conservatively. This upper bound
// survives a process crash and observation resets; cached requests cannot go unseen.
const EVIDENCE_INTERVAL_MS = 5_000;
const evidence = new WeakMap<SQL, Map<LegacyAppPath, { until: number; pending?: Promise<void> }>>();
export const recordLegacyAppUse = async (path: LegacyAppPath, db: SQL = sql): Promise<void> => {
  let paths = evidence.get(db);
  if (!paths) {
    paths = new Map();
    evidence.set(db, paths);
  }
  const state: { until: number; pending?: Promise<void> } = paths.get(path) ?? { until: 0 };
  paths.set(path, state);
  if (performance.now() < state.until) return;
  if (state.pending) return state.pending;
  const started = performance.now();
  const write = async () => {
    const [row] = await db<{ remaining_ms: number }[]>`
      WITH claimed AS (
        SELECT path FROM auth.app_migration_legacy WHERE path = ${path} FOR UPDATE SKIP LOCKED
      ), updated AS (
        UPDATE auth.app_migration_legacy SET last_used_at = clock_timestamp() + (${EVIDENCE_INTERVAL_MS} * interval '1 millisecond')
        FROM claimed WHERE auth.app_migration_legacy.path = claimed.path RETURNING last_used_at
      )
      SELECT EXTRACT(EPOCH FROM (last_used_at - clock_timestamp())) * 1000 AS remaining_ms FROM updated
      UNION ALL
      SELECT EXTRACT(EPOCH FROM (last_used_at - clock_timestamp())) * 1000 AS remaining_ms
      FROM auth.app_migration_legacy WHERE path = ${path} AND last_used_at > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM updated)`;
    // Only the request establishing new coverage must fail on missing evidence.
    // A locked row may supply already committed coverage, but never an uncommitted write.
    if (!row || row.remaining_ms <= 0) throw new Error("Legacy-use evidence unavailable; retry the request");
    const until = started + Number(row.remaining_ms);
    if (until <= performance.now()) throw new Error("Legacy-use evidence expired; retry the request");
    state.until = until;
  };
  state.pending = write();
  try {
    await state.pending;
  } finally {
    state.pending = undefined;
  }
};

/** Old Core replicas cannot establish a trustworthy clean observation. */
export const coreEvidenceIssues = (instances: { appId: string; instanceId: string; legacyEvidence?: unknown }[]) => {
  const cores = instances.filter((instance) => instance.appId === "core");
  return cores.length
    ? cores
        .filter((instance) => instance.legacyEvidence !== 1)
        .map((instance) => ({
          key: `${APP_INSTANCE_PREFIX}core/${instance.instanceId}`,
          reason: "core_legacy_evidence_missing",
        }))
    : [{ key: `${APP_INSTANCE_PREFIX}core/`, reason: "core_legacy_evidence_missing" }];
};
export const beginAppMigrationObservation = async (input: { actor: Pick<User, "id" | "uid" | "provider" | "roles"> }, db: SQL = sql) => {
  if (!input.actor.roles.includes("admin")) return fail(err.forbidden("Administrator access required"));
  const instances = await appInstanceRegistry().snapshot({ prefix: APP_INSTANCE_PREFIX });
  if (coreEvidenceIssues(instances.entries.map((entry) => entry.value)).length)
    return fail(err.conflict("Upgrade every live Core replica before starting observation"));
  return db.begin(async (tx) => {
    const [row] = await tx<{ started_at: Date }[]>`INSERT INTO auth.app_migration_observation (singleton, started_at)
      VALUES (true, clock_timestamp()) ON CONFLICT (singleton) DO UPDATE SET started_at = EXCLUDED.started_at RETURNING started_at`;
    if (!row) throw new Error("Observation did not start");
    await audit.record(
      {
        action: "app_migration.observation_begin",
        outcome: "allowed",
        actor: { userId: input.actor.id, uid: input.actor.uid, provider: input.actor.provider, roles: input.actor.roles },
        target: { type: "app_migration", id: "observation" },
        metadata: { startedAt: row.started_at.toISOString() },
      },
      tx,
    );
    return ok({ startedAt: row.started_at.toISOString() });
  });
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
