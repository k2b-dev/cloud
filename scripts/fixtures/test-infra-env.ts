/**
 * Maps `CLOUD_TEST_*` targets to the runtime variables Cloud reads. Pure and
 * side-effect free so that `scripts/run-tests.ts` can compute the child
 * environment before Bun starts and `test-infra.ts` can apply the same table
 * as a preload.
 *
 * A missing Postgres or Valkey target maps to a closed loopback port instead
 * of being removed: Bun's default `sql` and `redis` handles fall back to
 * `localhost` when their variable is unset, so an ungated test that reaches
 * for them must fail with a connection error rather than touch the stack from
 * `.env`. Every other target is removed when missing, because "unset" is the
 * documented off switch for those clients (`NATS_SERVERS` defaults to none).
 */
export type InfraKind = "database" | "nats" | "valkey" | "filegate" | "gotenberg" | "rsql";

export type InfraMapping = { test: string; runtime: string[]; unset?: string };

export const infraMappings: Record<InfraKind, InfraMapping> = {
  database: {
    test: "CLOUD_TEST_DATABASE_URL",
    runtime: ["DATABASE_URL", "POSTGRES_URL", "PGURL"],
    unset: "postgres://127.0.0.1:1/unset",
  },
  nats: { test: "CLOUD_TEST_NATS_SERVERS", runtime: ["NATS_SERVERS", "SYNC_TEST_SERVERS", "NATS_ADMIN_SERVERS"] },
  valkey: { test: "CLOUD_TEST_VALKEY_URL", runtime: ["REDIS_URL", "VALKEY_URL"], unset: "redis://127.0.0.1:1" },
  filegate: { test: "CLOUD_TEST_FILEGATE_URL", runtime: ["FILEGATE_URL", "FILESV2_TEST_FILEGATE_URL"] },
  gotenberg: { test: "CLOUD_TEST_GOTENBERG_URL", runtime: ["GOTENBERG_URL", "GRIDS_PDF_URL"] },
  rsql: { test: "CLOUD_TEST_RSQL_URL", runtime: ["RSQL_URL", "RSQL_TEST_URL"] },
};

export const readTestTarget = (env: Record<string, string | undefined>, kind: InfraKind): string | undefined =>
  env[infraMappings[kind].test]?.trim() || undefined;

/**
 * Runtime variables for the `CLOUD_TEST_*` targets in `env`: every alias gets
 * the target, its fail-fast address, or `undefined` when it must be removed.
 */
export const testRuntimeEnv = (env: Record<string, string | undefined>): Record<string, string | undefined> => {
  const out: Record<string, string | undefined> = {};
  for (const [kind, mapping] of Object.entries(infraMappings) as Array<[InfraKind, InfraMapping]>) {
    const value = readTestTarget(env, kind) ?? mapping.unset;
    for (const runtime of mapping.runtime) out[runtime] = value;
  }
  return out;
};

/** Applies `testRuntimeEnv` to a mutable environment, removing aliases whose target is absent. */
export const applyTestRuntimeEnv = (env: Record<string, string | undefined>): void => {
  for (const [key, value] of Object.entries(testRuntimeEnv(env))) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
};
