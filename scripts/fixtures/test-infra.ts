/**
 * Shared test-infrastructure gate.
 *
 * Integration suites gate themselves on the presence of `CLOUD_TEST_*`
 * variables. When a variable is present, the suite runs and fails loudly if
 * the target is unreachable. When it is absent, the suite is skipped and the
 * runtime variables are removed; `DATABASE_URL` and `REDIS_URL` instead point
 * at a closed loopback port (`test-infra-env.ts`), because Bun's default `sql`
 * and `redis` handles would otherwise dial `localhost` and reach the stack
 * configured in `.env`.
 *
 * With a target configured, the fixture refuses a process that may have loaded
 * a checkout's `.env` (`dotenvLeak` in `test-infra-env.ts`): its development
 * values, such as `APP_URL`, would otherwise become the tests' configuration.
 * `bun run test` starts every test process with `--no-env-file`.
 *
 * Import this module first in every integration test file. It is also loaded
 * as a `bun test` preload from `bunfig.toml` and by `scripts/run-tests.ts`.
 *
 * With a NATS target, tests connect through `connectTestNats()` (`test-nats.ts`),
 * which refuses the development account, and each test process gets its own
 * `test-` Sync namespace. Its streams, and those of the namespaces derived
 * from it with `testSyncNamespace()`, are deleted once the process's tests are
 * done (`test-sync.ts`).
 *
 * The preload selects runtime URLs before initializing the platform's native
 * clients. After selecting another private database, initializeTestPlatform()
 * closes the old clients and binds both handles to the new snapshot.
 *
 *   CLOUD_TEST_DATABASE_URL   postgres://user:pass@host:5432/<name>_test
 *   CLOUD_TEST_NATS_SERVERS   nats://host:4222[,nats://host:4223]
 *   CLOUD_TEST_NATS_CREDS_FILE absolute path of the test identity (.local/nats/test.creds)
 *   CLOUD_TEST_VALKEY_URL     redis://host:6379 (no database index)
 *   CLOUD_TEST_FILEGATE_URL   http://host:4000
 *   CLOUD_TEST_GOTENBERG_URL  http://host:3001
 *   CLOUD_TEST_CLICKHOUSE_URL http://admin:password@host:8123 (dedicated test admin)
 *   CLOUD_TEST_S3_ENDPOINT    http://host:3900 (dedicated Garage test instance)
 *   CLOUD_TEST_S3_BUCKET      cloud-test (must end in -test)
 *   CLOUD_TEST_S3_ACCESS_KEY_ID / CLOUD_TEST_S3_SECRET_ACCESS_KEY / CLOUD_TEST_S3_REGION
 *   CLOUD_TEST_RSQL_URL       http://host:8080
 */
import { afterAll, afterEach, beforeAll, describe, test } from "bun:test";
import { S3Client, SQL } from "bun";
import { sql } from "../../packages/cloud/src/runtime/clients";
import {
  applyTestRuntimeEnv,
  dotenvLeak,
  type InfraKind,
  infraMappings as mappings,
  quoteTestDatabase,
  readTestTarget,
} from "./test-infra-env";
import { connectTestNats } from "./test-nats";
import { cancellingTestWork, finishTestWork, observeTestWork } from "./test-work";

export type { InfraKind } from "./test-infra-env";
export { connectTestNats } from "./test-nats";
// Unit and CLI processes load this gate too; do not load server clients until needed.
export const initializeTestPlatform = async (appId?: string): Promise<void> => {
  const platform = await import("./platform");
  await platform.initializeTestPlatform(appId);
};

const testOnlyDefaults: Record<string, string> = {
  APP_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  CLOUD_OAUTH_BROKER_SECRET: "abababababababababababababababababababababababababababababababab",
  CLOUD_IDENTITY_KEY_ENCRYPTION_KEY: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  SYNC_REPLICAS: "1",
  NATS_IGNORE_CLUSTER_UPDATES: "true",
};

const read = (key: string): string | undefined => process.env[key]?.trim() || undefined;

/**
 * The @k2b/sync namespace of this test process. It replaces any
 * `SYNC_NAMESPACE` from the environment or `.env`, so tests never share a
 * namespace with a running installation, and it is deleted with every
 * namespace derived from it once the process's tests are done.
 */
const processNamespace = `test-${crypto.randomUUID().slice(0, 8)}`;

const assertTestDatabaseName = (url: string): void => {
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!name.endsWith("_test")) {
    throw new Error(
      `CLOUD_TEST_DATABASE_URL must point to a database whose name ends with "_test" (got "${name}"). ` +
        "Integration tests create and delete rows; never run them against a development or production database.",
    );
  }
  quoteTestDatabase(name);
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
    if (kind === "s3" && value) {
      const bucket = read("CLOUD_TEST_S3_BUCKET");
      if (!bucket?.endsWith("-test")) throw new Error("CLOUD_TEST_S3_BUCKET must name a dedicated bucket ending in -test.");
      if (!read("CLOUD_TEST_S3_ACCESS_KEY_ID") || !read("CLOUD_TEST_S3_SECRET_ACCESS_KEY") || !read("CLOUD_TEST_S3_REGION")) {
        throw new Error("Set CLOUD_TEST_S3_ACCESS_KEY_ID, CLOUD_TEST_S3_SECRET_ACCESS_KEY, and CLOUD_TEST_S3_REGION with the S3 endpoint.");
      }
    }
    resolved[kind] = value;
  }
  applyTestRuntimeEnv(process.env);
  if (Object.values(resolved).some(Boolean)) {
    const envFile = dotenvLeak(process.cwd(), process.execArgv);
    if (envFile) {
      throw new Error(
        `This integration test process started without --no-env-file next to ${envFile}; development values such as APP_URL would replace the test defaults. ` +
          "Run integration tests through `bun run test`, or set BUN_OPTIONS=--no-env-file for a direct run; unlike `bun --no-env-file`, it also reaches the Bun processes tests start.",
      );
    }
    for (const [key, value] of Object.entries(testOnlyDefaults)) {
      if (!read(key)) process.env[key] = value;
    }
    process.env.SYNC_NAMESPACE = processNamespace;
  }
  return resolved;
};

/** Resolved `CLOUD_TEST_*` targets; `undefined` means the suite must skip. */
export const testInfra: Readonly<Record<InfraKind, string | undefined>> = applyMappings();
if (Object.values(testInfra).some(Boolean)) await initializeTestPlatform();

const tcpReachable = async (url: string): Promise<void> => {
  const parsed = new URL(url);
  const port = Number(parsed.port || 6379);
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
  s3: async (target) => {
    const client = new S3Client({
      endpoint: target,
      bucket: read("CLOUD_TEST_S3_BUCKET"),
      accessKeyId: read("CLOUD_TEST_S3_ACCESS_KEY_ID"),
      secretAccessKey: read("CLOUD_TEST_S3_SECRET_ACCESS_KEY"),
      region: read("CLOUD_TEST_S3_REGION"),
      retry: 0,
    });
    await client.list({ maxKeys: 1 });
  },
  database: async (target) => {
    const sql = new SQL(target);
    try {
      await sql`SELECT 1`;
    } finally {
      await sql.close();
    }
  },
  nats: async () => {
    const connection = await connectTestNats({ timeout: 3_000, reconnect: false });
    await connection.close();
  },
  valkey: tcpReachable,
  filegate: httpReachable,
  gotenberg: httpReachable,
  rsql: httpReachable,
  clickhouse: async (target) => {
    const url = new URL(target);
    const authorization = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
    const response = await fetch(`${url.origin}/ping`, {
      headers: { authorization },
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok || (await response.text()).trim() !== "Ok.") throw new Error("ClickHouse ping failed");
  },
};

const verified = new Map<InfraKind, Promise<void>>();

/** Throws a clear error when a configured `CLOUD_TEST_*` target is unreachable. */
export const requireInfra = async (...needs: InfraKind[]): Promise<void> => {
  for (const kind of needs) {
    const target = testInfra[kind];
    if (!target) throw new Error(`${mappings[kind].test} is not set`);
    let probe = verified.get(kind);
    if (!probe) {
      probe = probes[kind](target).catch(() => {
        // Client errors may contain credentials or even an entire server response.
        throw new Error(`${mappings[kind].test}=${redactTarget(target)} is set but not usable: target probe failed`);
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

/** Bind platform clients to a private, empty database for suites that build
 * their own schema. Select it before importing domain code; call drop() in afterAll. */
export const useFreshDatabase = async (prefix: string): Promise<{ url: string; name: string; drop: () => Promise<void> }> => {
  return bindDefaultDatabase(prefix, await createDisposableDatabase(prefix));
};

const migratedDatabaseUrls = new Set<string>();
// Unit tests and their subprocesses preload this gate without needing workspace discovery.
let databaseTemplate: Promise<typeof import("./test-database-template")> | undefined;

/** Whether the currently selected database was cloned with all production schemas. */
export const usesMigratedDatabase = (): boolean => migratedDatabaseUrls.has(process.env.DATABASE_URL ?? "");

/** A private clone of all migrated Core and application schemas, without replaying setup. */
export const createMigratedDatabase = async (prefix: string) => {
  const target = requireDatabaseUrl();
  databaseTemplate ??= import("./test-database-template");
  const { migratedDatabaseTemplate } = await databaseTemplate;
  const database = await createDisposableDatabase(prefix, await migratedDatabaseTemplate(target));
  migratedDatabaseUrls.add(database.url);
  return database;
};

/** Like useFreshDatabase, but starts with the migrated schema instead of an empty database. */
export const useMigratedDatabase = async (prefix: string) => bindDefaultDatabase(prefix, await createMigratedDatabase(prefix));

const bindDefaultDatabase = async (prefix: string, database: Awaited<ReturnType<typeof createDisposableDatabase>>) => {
  process.env.DATABASE_URL = database.url;
  ownTestDatabase(database.name);
  await initializeTestPlatform();
  const [row] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
  if (row?.name !== database.name) {
    await database.drop();
    throw new Error(`${prefix}: the platform sql handle is already bound to "${row?.name}"; run this file in its own process`);
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

/**
 * A private Sync namespace for a test that creates its own Sync instance. It
 * is derived from the process namespace, so the fixture deletes its streams
 * after the test file's own hooks, whether the tests passed or failed.
 */
export const testSyncNamespace = (label: string): string => `${processNamespace}-${label}-${crypto.randomUUID().slice(0, 8)}`;

// Preload hooks run after every hook of the test files, in preload order. A later
// preload that keeps a Sync running until its own `afterAll` (Mail) therefore uses
// a namespace of its own and deletes it after draining. Imported by a test file
// instead, this hook belongs to that file: it runs before the file's own hooks and
// misses later files. `bun run test` sweeps what remains and the namespaces of
// killed processes (`test-sync.ts`).
if (testInfra.nats) {
  try {
    afterAll(async () => {
      const { deleteTestNamespace } = await import("./test-sync");
      await deleteTestNamespace(processNamespace);
    });
  } catch {
    // Loaded by a script outside `bun test` (integration bootstrap, Grids verification), which runs no tests.
  }
}

try {
  afterAll(async () => {
    if (databaseTemplate) await (await databaseTemplate).closeMigratedDatabaseTemplate();
  });
} catch {
  // Bootstrap scripts outside bun test close their lease explicitly.
}

// Private databases this process owns: nothing else runs in them, so work that outlives a test belongs to this process.
const ownedDatabases = new Set<string>();

/** Marks a private database of this process, so work an aborted test leaves running there ends after each test. */
export const ownTestDatabase = (name: string): void => {
  ownedDatabases.add(name);
};

/**
 * Ends work that outlives its test in this process's private databases. Bun cannot stop the body of a test that timed
 * out, so its statements keep running, or its transaction keeps holding locks, and every later hook waits on them.
 * Statements still running are cancelled and transactions left open are ended; each is reported with its blockers.
 */
export const endLingeringTestWork = async (): Promise<string[]> => {
  if (ownedDatabases.size === 0) return [];
  const admin = new SQL(requireDatabaseUrl(), { max: 1 });
  try {
    type Lingering = { pid: number; database: string; state: string; ms: number; query: string; blockers: number[]; wait: string };
    const rows: Lingering[] = [];
    for (const database of ownedDatabases)
      rows.push(
        ...(await admin<Lingering[]>`
          SELECT pid, datname AS database, state, (extract(epoch FROM now() - state_change) * 1000)::int AS ms,
            left(query, 300) AS query, pg_blocking_pids(pid) AS blockers,
            coalesce(wait_event_type || ':' || wait_event, 'running') AS wait
          FROM pg_stat_activity
          WHERE datname = ${database} AND pid <> pg_backend_pid()
            AND (state = 'active' OR state LIKE 'idle in transaction%') AND state_change < now() - interval '250 milliseconds'`),
      );
    const reports: string[] = [];
    for (const row of rows) {
      const action = row.state === "active" ? "cancelled" : "ended";
      cancellingTestWork();
      if (row.state === "active") {
        await admin`SELECT pg_cancel_backend(${row.pid})`;
      } else {
        await admin`SELECT pg_terminate_backend(${row.pid})`;
      }
      reports.push(
        `${action} ${row.state} work in ${row.database} after ${row.ms} ms (pid ${row.pid}, blocked by ${row.blockers.join(", ") || "nothing"}, waiting on ${row.wait}): ${row.query}`,
      );
    }
    for (const report of reports) console.warn(`[test-infra] work outlived its test and was ${report}`);
    return reports;
  } finally {
    await admin.close();
  }
};

try {
  afterEach(async () => {
    finishTestWork();
    await endLingeringTestWork();
  });
} catch {
  // Loaded by a script outside bun test, which runs no tests.
}

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
export const createDisposableDatabase = async (
  prefix: string,
  template?: string,
): Promise<{ url: string; name: string; drop: () => Promise<void> }> => {
  const admin = new URL(requireDatabaseUrl());
  const name = `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}_test`;
  const identifier = quoteTestDatabase(name);
  const source = template ? ` TEMPLATE ${quoteTestDatabase(template)}` : "";
  const sql = new SQL(admin.toString());
  try {
    await sql.unsafe(`CREATE DATABASE ${identifier}${source}`);
  } finally {
    await sql.close();
  }
  const url = new URL(admin.toString());
  url.pathname = `/${encodeURIComponent(name)}`;
  return {
    url: url.toString(),
    name,
    drop: async () => {
      const drop = new SQL(admin.toString());
      try {
        await drop.unsafe(`DROP DATABASE IF EXISTS ${identifier} WITH (FORCE)`);
      } finally {
        await drop.close();
      }
    },
  };
};

/** Diagnostics retain the target but never URL credentials, for every infrastructure kind. */
export const redactTarget = (target: string): string =>
  target
    .split(",")
    .map((part) => {
      try {
        const url = new URL(part);
        if (url.password) url.password = "REDACTED";
        // Query parameters can also contain credentials; probes do not need them in diagnostics.
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[invalid URL]";
      }
    })
    .join(",");

// Install after registering the fixture's own hooks, but before test files load.
// beforeAll may claim a private database only after its tests were registered.
if (testInfra.database) observeTestWork();
