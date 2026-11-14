import { RedisClient, type RedisOptions, SQL } from "bun";
import { postgresApplicationOptions } from "../_internal/postgres-application-name";
import { env } from "../config/env";
import { connections } from "./connections";

export type SqlPoolOptions = SQL.PostgresOrMySQLOptions;

// Bun 1.4 forwards every URL query key except TLS modes and path to Postgres.
// Keep client-only settings in the native options object, never in that packet.
const clientUrlOptions = new Set<string>(
  (
    [
      "url",
      "host",
      "hostname",
      "port",
      "username",
      "user",
      "password",
      "pass",
      "database",
      "db",
      "adapter",
      "idleTimeout",
      "idle_timeout",
      "connectionTimeout",
      "connection_timeout",
      "connectTimeout",
      "connect_timeout",
      "maxLifetime",
      "max_lifetime",
      "onconnect",
      "onclose",
      "connection",
      "max",
      "bigint",
      "prepare",
      "allowPublicKeyRetrieval",
    ] satisfies (keyof SqlPoolOptions)[]
  ).map((key) => key.toLowerCase()),
);

/** Only the pre-start placeholder is proxied; initialized clients are native Bun objects. */
const notStarted = <T>(name: string): T => {
  const fail = (): never => {
    throw new Error(`${name} used before platform start`);
  };
  return new Proxy(fail, {
    get: fail,
    set: fail,
    apply: fail,
    construct: fail,
    getPrototypeOf: fail,
    defineProperty: fail,
    deleteProperty: fail,
    has: fail,
    ownKeys: fail,
    getOwnPropertyDescriptor: fail,
    setPrototypeOf: fail,
    isExtensible: fail,
    preventExtensions: fail,
  }) as T;
};

export let sql: SQL = notStarted("sql");
export let redis: RedisClient = notStarted("redis");
// Whether `sql` and `redis` hold native clients; teardown must not touch the placeholders.
let live = false;

/** Own pool and lifecycle; defaults to the installation URL and application name. */
export const createSql = (options: SqlPoolOptions = {}): SQL => {
  const state = connections();
  const url = options.url ?? state.database.url;
  if ([...new URL(url).searchParams.keys()].some((key) => clientUrlOptions.has(key.toLowerCase()))) {
    // Do not echo keys, values or URLs: they can contain credentials.
    throw new Error("SQL URL contains a client option; use createSql options or CLOUD_DATABASE_POOL_MAX");
  }
  const connection = { ...postgresApplicationOptions(state.appId, url.toString()), ...options.connection };
  return new SQL({
    ...options,
    url,
    ...(Object.keys(connection).length ? { connection } : {}),
  });
};

/** Own connection and lifecycle, using the installation's Valkey URL. */
export const createRedis = (options?: RedisOptions): RedisClient => new RedisClient(connections().valkey.url, options);

export const initializeClients = async (): Promise<void> => {
  const max = env.CLOUD_DATABASE_POOL_MAX;
  let database: SQL;
  try {
    database = createSql({ max });
  } catch {
    throw new Error(
      "Postgres client configuration is invalid; check DATABASE_URL and keep client options outside its query string; use CLOUD_DATABASE_POOL_MAX or createSql options",
    );
  }
  try {
    const valkey = createRedis();
    sql = database;
    redis = valkey;
    live = true;
  } catch {
    await database.close();
    throw new Error("Valkey client configuration is invalid; check REDIS_URL and native Redis options");
  }
};

/** Internal test-target teardown, before a fixture selects a different database. */
export const closePlatformClients = async (): Promise<void> => {
  if (live) {
    live = false;
    await sql.close();
    redis.close();
  }
  sql = notStarted("sql");
  redis = notStarted("redis");
};
