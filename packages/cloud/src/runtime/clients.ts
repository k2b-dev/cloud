import { RedisClient, type RedisOptions, SQL } from "bun";
import { postgresApplicationOptions } from "../_internal/postgres-application-name";
import { connections } from "./connections";

export type SqlPoolOptions = SQL.PostgresOrMySQLOptions;

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
  let database: SQL;
  try {
    database = createSql();
  } catch {
    throw new Error("Postgres client configuration is invalid; check DATABASE_URL and native SQL options");
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
