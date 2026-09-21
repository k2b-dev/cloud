/**
 * Maps `CLOUD_TEST_*` targets to the runtime variables Cloud reads. Pure and
 * side-effect free so that `scripts/run-tests.ts` can compute the child
 * environment before Bun starts and `test-infra.ts` can apply the same table
 * as a preload.
 *
 * A missing target maps to a closed loopback port instead of being removed:
 * Bun's default `sql` and `redis` handles fall back to `localhost` when their
 * variable is unset, so an ungated test that reaches for infrastructure must
 * fail with a connection error rather than touch the stack from `.env`.
 */
export type InfraKind = "database" | "nats" | "valkey" | "filegate" | "gotenberg" | "rsql";

export type InfraMapping = { test: string; runtime: string[]; unset: string };

export const infraMappings: Record<InfraKind, InfraMapping> = {
  database: {
    test: "CLOUD_TEST_DATABASE_URL",
    runtime: ["DATABASE_URL", "POSTGRES_URL", "PGURL"],
    unset: "postgres://127.0.0.1:1/unset",
  },
  nats: {
    test: "CLOUD_TEST_NATS_SERVERS",
    runtime: ["NATS_SERVERS", "SYNC_TEST_SERVERS", "NATS_ADMIN_SERVERS"],
    unset: "nats://127.0.0.1:1",
  },
  valkey: { test: "CLOUD_TEST_VALKEY_URL", runtime: ["REDIS_URL", "VALKEY_URL"], unset: "redis://127.0.0.1:1" },
  filegate: { test: "CLOUD_TEST_FILEGATE_URL", runtime: ["FILEGATE_URL", "FILESV2_TEST_FILEGATE_URL"], unset: "http://127.0.0.1:1" },
  gotenberg: { test: "CLOUD_TEST_GOTENBERG_URL", runtime: ["GOTENBERG_URL", "GRIDS_PDF_URL"], unset: "http://127.0.0.1:1" },
  rsql: { test: "CLOUD_TEST_RSQL_URL", runtime: ["RSQL_URL", "RSQL_TEST_URL"], unset: "http://127.0.0.1:1" },
};

export const readTestTarget = (env: Record<string, string | undefined>, kind: InfraKind): string | undefined =>
  env[infraMappings[kind].test]?.trim() || undefined;

/** Runtime variables for the `CLOUD_TEST_*` targets in `env`; every alias gets the target or its fail-fast address. */
export const testRuntimeEnv = (env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [kind, mapping] of Object.entries(infraMappings) as Array<[InfraKind, InfraMapping]>) {
    const value = readTestTarget(env, kind) ?? mapping.unset;
    for (const runtime of mapping.runtime) out[runtime] = value;
  }
  return out;
};
