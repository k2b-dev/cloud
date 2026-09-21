/**
 * Shared test-infrastructure gate.
 *
 * Integration suites gate themselves on the presence of `CLOUD_TEST_*`
 * variables. When a variable is present, the suite runs and fails loudly if
 * the target is unreachable. When it is absent, the suite is skipped and the
 * runtime variables point at a closed loopback port (`test-infra-env.ts`), so
 * an ungated test that reaches for infrastructure fails with a connection
 * error instead of touching the stack configured in `.env`.
 *
 * Import this module first in every integration test file. It is also loaded
 * as a `bun test` preload from `bunfig.toml` and by `scripts/run-tests.ts`.
 *
 * Bun's default `redis` handle resolves `REDIS_URL` when the process starts,
 * before any preload runs. `bun run test` therefore exports the aliases into
 * the child environment first; under a direct `bun test`, the default handle
 * is only redirected when `REDIS_URL` was exported before Bun started. The
 * default `sql` handle binds on its first query and the NATS registry reads
 * lazily, so those follow the preload in both cases.
 *
 *   CLOUD_TEST_DATABASE_URL   postgres://user:pass@host:5432/<name>_test
 *   CLOUD_TEST_NATS_SERVERS   nats://host:4222[,nats://host:4223]
 *   CLOUD_TEST_VALKEY_URL     redis://host:6379 (no database index)
 *   CLOUD_TEST_FILEGATE_URL   http://host:4000
 *   CLOUD_TEST_GOTENBERG_URL  http://host:3001
 *   CLOUD_TEST_RSQL_URL       http://host:8080
 */
import { beforeAll, describe, test } from "bun:test";
import { type InfraKind, infraMappings as mappings, readTestTarget, testRuntimeEnv } from "./test-infra-env";

export type { InfraKind } from "./test-infra-env";

const testOnlyDefaults: Record<string, string> = {
  APP_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  CLOUD_OAUTH_BROKER_SECRET: "abababababababababababababababababababababababababababababababab",
  CLOUD_IDENTITY_KEY_ENCRYPTION_KEY: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  SYNC_REPLICAS: "1",
  NATS_IGNORE_CLUSTER_UPDATES: "true",
};

const read = (key: string): string | undefined => process.env[key]?.trim() || undefined;

const assertTestDatabaseName = (url: string): void => {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(
      `CLOUD_TEST_DATABASE_URL must point to a database whose name ends with "_test" (got "${name}"). ` +
        "Integration tests create and delete rows; never run them against a development or production database.",
    );
  }
};

const assertValkeyUrlWithoutIndex = (url: string): void => {
  const path = new URL(url).pathname;
  if (path !== "" && path !== "/" && path !== "/0") {
    throw new Error(
      `CLOUD_TEST_VALKEY_URL must not select a database index (got "${path}"): Bun's default redis client and RedisClient disagree on the path, so tests would read from different databases.`,
    );
  }
};

const applyMappings = (): Record<InfraKind, string | undefined> => {
  const resolved = {} as Record<InfraKind, string | undefined>;
  for (const kind of Object.keys(mappings) as InfraKind[]) {
    const value = readTestTarget(process.env, kind);
    if (kind === "database" && value) assertTestDatabaseName(value);
    if (kind === "valkey" && value) assertValkeyUrlWithoutIndex(value);
    resolved[kind] = value;
  }
  Object.assign(process.env, testRuntimeEnv(process.env));
  if (Object.values(resolved).some(Boolean)) {
    for (const [key, value] of Object.entries(testOnlyDefaults)) {
      if (!read(key)) process.env[key] = value;
    }
    if (!read("SYNC_NAMESPACE")) process.env.SYNC_NAMESPACE = `test-${crypto.randomUUID().slice(0, 8)}`;
  }
  return resolved;
};

/** Resolved `CLOUD_TEST_*` targets; `undefined` means the suite must skip. */
export const testInfra: Readonly<Record<InfraKind, string | undefined>> = applyMappings();

const tcpReachable = async (url: string): Promise<void> => {
  const parsed = new URL(url);
  const port = Number(parsed.port || (parsed.protocol === "nats:" ? 4222 : 6379));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout connecting to ${parsed.hostname}:${port}`)), 3_000);
    Bun.connect({
      hostname: parsed.hostname,
      port,
      socket: {
        open(socket) {
          clearTimeout(timer);
          socket.end();
          resolve();
        },
        data() {},
        error(_socket, error) {
          clearTimeout(timer);
          reject(error);
        },
        connectError(_socket, error) {
          clearTimeout(timer);
          reject(error);
        },
      },
    }).catch(reject);
  });
};

const httpReachable = async (url: string): Promise<void> => {
  const base = url.replace(/\/$/, "");
  const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3_000) }).catch(() =>
    fetch(base, { signal: AbortSignal.timeout(3_000) }),
  );
  if (!response.ok && response.status >= 500) throw new Error(`${base} answered ${response.status}`);
};

const probes: Record<InfraKind, (target: string) => Promise<void>> = {
  database: async (target) => {
    const { SQL } = await import("bun");
    const sql = new SQL(target);
    try {
      await sql`SELECT 1`;
    } finally {
      await sql.close();
    }
  },
  nats: async (target) => {
    for (const server of target.split(",")) await tcpReachable(server.trim());
  },
  valkey: tcpReachable,
  filegate: httpReachable,
  gotenberg: httpReachable,
  rsql: httpReachable,
};

const verified = new Map<InfraKind, Promise<void>>();

/** Throws a clear error when a configured `CLOUD_TEST_*` target is unreachable. */
export const requireInfra = async (...needs: InfraKind[]): Promise<void> => {
  for (const kind of needs) {
    const target = testInfra[kind];
    if (!target) throw new Error(`${mappings[kind].test} is not set`);
    let probe = verified.get(kind);
    if (!probe) {
      probe = probes[kind](target).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${mappings[kind].test}=${target} is set but unreachable: ${message}`);
      });
      verified.set(kind, probe);
    }
    await probe;
  }
};

/**
 * `describe` when every requested target is configured, otherwise
 * `describe.skip`. A configured but unreachable target fails the suite.
 */
export const suiteFor = (...needs: InfraKind[]): typeof describe => {
  const missing = needs.filter((kind) => !testInfra[kind]);
  if (missing.length > 0) return describe.skip;
  const gated = ((name: string, fn: () => void) =>
    describe(name, () => {
      beforeAll(async () => {
        await requireInfra(...needs);
      });
      fn();
    })) as typeof describe;
  return Object.assign(gated, describe);
};

/** `test` when every requested target is configured, otherwise `test.skip`. */
export const testFor = (...needs: InfraKind[]): typeof test => (needs.every((kind) => testInfra[kind]) ? test : (test.skip as typeof test));

export const databaseSuite = (): typeof describe => suiteFor("database");

/**
 * Points Bun's default `sql` handle at a private, empty database for suites
 * that build their own schema. The default handle binds `DATABASE_URL` on its
 * first query, so such a file must run in its own process (`bun test --isolate`)
 * before any other query; otherwise this throws instead of touching the shared
 * test database. Call `drop()` in `afterAll`.
 */
export const useFreshDatabase = async (prefix: string): Promise<{ url: string; name: string; drop: () => Promise<void> }> => {
  const database = await createDisposableDatabase(prefix);
  process.env.DATABASE_URL = database.url;
  const { sql } = await import("bun");
  const [row] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
  if (row?.name !== database.name) {
    await database.drop();
    throw new Error(
      `${prefix}: the default sql handle is already bound to "${row?.name}"; run this file in its own process (bun test --isolate)`,
    );
  }
  return database;
};
export const natsSuite = (): typeof describe => suiteFor("nats");
export const valkeySuite = (): typeof describe => suiteFor("valkey");

/** The configured NATS test servers; throws when they are not set. */
export const natsServers = (): string[] => {
  const servers = testInfra.nats;
  if (!servers) throw new Error("CLOUD_TEST_NATS_SERVERS is not set");
  return servers.split(",").map((server) => server.trim());
};

/** The configured target for one infrastructure kind; throws when it is not set. */
export const requireInfraUrl = (kind: InfraKind): string => {
  const url = testInfra[kind];
  if (!url) throw new Error(`${mappings[kind].test} is not set`);
  return url;
};

/** The configured test database URL; throws when it is not set. */
export const requireDatabaseUrl = (): string => requireInfraUrl("database");

/**
 * Creates a private database on the configured test server. The name always
 * ends with `_test`. Callers must `drop()` in a `finally` or `afterAll`.
 */
export const createDisposableDatabase = async (prefix: string): Promise<{ url: string; name: string; drop: () => Promise<void> }> => {
  const admin = new URL(requireDatabaseUrl());
  const name = `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}_test`;
  const { SQL } = await import("bun");
  const sql = new SQL(admin.toString());
  try {
    await sql.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await sql.close();
  }
  const url = new URL(admin.toString());
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    name,
    drop: async () => {
      const drop = new SQL(admin.toString());
      try {
        await drop.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await drop.close();
      }
    },
  };
};
