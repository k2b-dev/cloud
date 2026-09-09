import { sql } from "bun";
import { formatDurationMs, formatNumber, formatPercent } from "@k2b/cloud/shared";
import { gatewayOpsMessages } from "../../messages";

export type DiagnosticWarning = {
  area: "postgres" | "redis";
  tone: "amber" | "red";
  title: string;
  detail: string;
};

export type PostgresTableDiagnostic = {
  schema: string;
  name: string;
  estimatedRows: number;
  deadRows: number;
  seqScans: number;
  indexScans: number;
  tableBytes: number;
  indexBytes: number;
  totalBytes: number;
  lastVacuum: string | null;
  lastAutovacuum: string | null;
  lastAnalyze: string | null;
  lastAutoanalyze: string | null;
  warnings: string[];
};

export type PostgresSchemaDiagnostic = {
  schema: string;
  tables: number;
  estimatedRows: number;
  totalBytes: number;
};

export type PostgresExtensionDiagnostic = {
  name: string;
  defaultVersion: string | null;
  installedVersion: string | null;
  installed: boolean;
  comment: string | null;
};

export type PostgresDiagnostics = {
  available: boolean;
  error: string | null;
  schemas: number;
  tables: number;
  totalBytes: number;
  installedExtensions: number;
  availableExtensions: number;
  runtime: {
    maxConnections: number;
    connections: number;
    activeConnections: number;
    idleInTransaction: number;
    waitingLocks: number;
    oldestWaitingQuerySeconds: number;
    oldestTransactionSeconds: number;
    oldestIdleTransactionSeconds: number;
    oldestQuerySeconds: number;
    deadlocks: number;
  };
  tableRows: PostgresTableDiagnostic[];
  schemaRows: PostgresSchemaDiagnostic[];
  extensionRows: PostgresExtensionDiagnostic[];
  warnings: DiagnosticWarning[];
};

export type RedisKeyspaceDb = {
  database: string;
  keys: number;
  expires: number;
  avgTtlMs: number;
};

export type RedisPrefixDiagnostic = {
  depth: number;
  prefix: string;
  count: number;
  share: number;
};

/** Health signals from `INFO`, all nullable because older servers omit fields. */
export type RedisRuntime = {
  usedMemoryBytes: number | null;
  maxMemoryBytes: number | null;
  maxMemoryPolicy: string | null;
  evictedKeys: number | null;
  expiredKeys: number | null;
  connectedClients: number | null;
  blockedClients: number | null;
  rejectedConnections: number | null;
  role: string | null;
  /** Fraction of lookups served from cache, or null when nothing was looked up. */
  hitRate: number | null;
};

export const emptyRedisRuntime = (): RedisRuntime => ({
  usedMemoryBytes: null,
  maxMemoryBytes: null,
  maxMemoryPolicy: null,
  evictedKeys: null,
  expiredKeys: null,
  connectedClients: null,
  blockedClients: null,
  rejectedConnections: null,
  role: null,
  hitRate: null,
});

export type RedisDiagnostics = {
  available: boolean;
  error: string | null;
  dbSize: number;
  sampledKeys: number;
  scanComplete: boolean;
  keyspace: RedisKeyspaceDb[];
  prefixes: RedisPrefixDiagnostic[];
  runtime: RedisRuntime;
  warnings: DiagnosticWarning[];
};

/**
 * A backend session. Answers "who is blocking" and "who holds the idle
 * connections" — questions the aggregate counts could pose but not resolve.
 */
export type PostgresSession = {
  pid: number;
  application: string | null;
  user: string | null;
  state: string | null;
  waitEventType: string | null;
  waitEvent: string | null;
  /** Seconds since the current query started; null when idle with no query. */
  queryAgeSeconds: number | null;
  /** Seconds since the transaction opened — the number that matters for bloat. */
  transactionAgeSeconds: number | null;
  blockedBy: number[];
  query: string | null;
};

export type PostgresIndexDiagnostic = {
  schema: string;
  table: string;
  name: string;
  sizeBytes: number;
  scans: number;
  isUnique: boolean;
  isPrimary: boolean;
};

export type DataDiagnostics = {
  postgres: PostgresDiagnostics;
  redis: RedisDiagnostics;
};

const MAX_REDIS_SAMPLE_KEYS = 10_000;
const REDIS_SCAN_BATCH = 1_000;
const LARGE_TABLE_BYTES = 100 * 1024 * 1024;

const toNumber = (value: unknown): number => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const emptyPostgres = (message: string, locale: string): PostgresDiagnostics => ({
  available: false,
  error: message,
  schemas: 0,
  tables: 0,
  totalBytes: 0,
  installedExtensions: 0,
  availableExtensions: 0,
  runtime: {
    maxConnections: 0,
    connections: 0,
    activeConnections: 0,
    idleInTransaction: 0,
    waitingLocks: 0,
    oldestWaitingQuerySeconds: 0,
    oldestTransactionSeconds: 0,
    oldestIdleTransactionSeconds: 0,
    oldestQuerySeconds: 0,
    deadlocks: 0,
  },
  tableRows: [],
  schemaRows: [],
  extensionRows: [],
  warnings: [
    {
      area: "postgres",
      tone: "red",
      title: gatewayOpsMessages.resolve([locale]).t.postgresDiagnosticsUnavailable,
      detail: message,
    },
  ],
});

const emptyRedis = (message: string, locale: string): RedisDiagnostics => ({
  available: false,
  error: message,
  dbSize: 0,
  sampledKeys: 0,
  scanComplete: false,
  keyspace: [],
  prefixes: [],
  runtime: emptyRedisRuntime(),
  warnings: [
    {
      area: "redis",
      tone: "red",
      title: gatewayOpsMessages.resolve([locale]).t.redisDiagnosticsUnavailable,
      detail: message,
    },
  ],
});

const tableWarnings = (table: Omit<PostgresTableDiagnostic, "warnings">): string[] => {
  const warnings: string[] = [];
  const analyzed = table.lastAnalyze || table.lastAutoanalyze;
  if (table.totalBytes >= LARGE_TABLE_BYTES) warnings.push("large table");
  if (table.estimatedRows > 1_000 && !analyzed) warnings.push("no analyze timestamp");
  if (table.deadRows > 1_000 && table.deadRows > table.estimatedRows * 0.2) warnings.push("many dead rows");
  return warnings;
};

const collectPostgres = async (locale: string): Promise<PostgresDiagnostics> => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  const [overview, tableRows, extensionRows] = await Promise.all([
    sql<
      {
        schemas: number;
        tables: number;
        total_bytes: number | string | bigint | null;
        max_connections: number | string;
        connections: number | string;
        active_connections: number | string;
        idle_in_transaction: number | string;
        waiting_locks: number | string;
        oldest_waiting_query_seconds: number | string | null;
        oldest_transaction_seconds: number | string | null;
        oldest_idle_transaction_seconds: number | string | null;
        oldest_query_seconds: number | string | null;
        deadlocks: number | string;
      }[]
    >`
      SELECT
        (SELECT COUNT(*)::int FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema') AS schemas,
        (SELECT COUNT(*)::int FROM pg_stat_user_tables) AS tables,
        (SELECT COALESCE(SUM(pg_total_relation_size(relid)), 0)::bigint FROM pg_stat_user_tables) AS total_bytes,
        current_setting('max_connections')::int AS max_connections,
        (SELECT count(*)::int FROM pg_stat_activity WHERE backend_type = 'client backend') AS connections,
        (SELECT count(*)::int FROM pg_stat_activity WHERE backend_type = 'client backend' AND state = 'active') AS active_connections,
        (SELECT count(*)::int FROM pg_stat_activity WHERE backend_type = 'client backend' AND state = 'idle in transaction') AS idle_in_transaction,
        (SELECT count(*)::int FROM pg_stat_activity WHERE backend_type = 'client backend' AND wait_event_type = 'Lock') AS waiting_locks,
        (SELECT COALESCE(max(EXTRACT(EPOCH FROM (now() - query_start))), 0)::float
          FROM pg_stat_activity
          WHERE backend_type = 'client backend' AND wait_event_type = 'Lock' AND query_start IS NOT NULL) AS oldest_waiting_query_seconds,
        (SELECT COALESCE(max(EXTRACT(EPOCH FROM (now() - xact_start))), 0)::float
          FROM pg_stat_activity
          WHERE backend_type = 'client backend' AND xact_start IS NOT NULL AND pid <> pg_backend_pid()) AS oldest_transaction_seconds,
        (SELECT COALESCE(max(EXTRACT(EPOCH FROM (now() - xact_start))), 0)::float
          FROM pg_stat_activity
          WHERE backend_type = 'client backend' AND state = 'idle in transaction' AND xact_start IS NOT NULL) AS oldest_idle_transaction_seconds,
        (SELECT COALESCE(max(EXTRACT(EPOCH FROM (now() - query_start))), 0)::float
          FROM pg_stat_activity
          WHERE backend_type = 'client backend' AND state = 'active' AND query_start IS NOT NULL AND pid <> pg_backend_pid()) AS oldest_query_seconds,
        (SELECT COALESCE(sum(deadlocks), 0)::bigint FROM pg_stat_database) AS deadlocks
    `,
    sql<
      {
        schemaname: string;
        relname: string;
        estimated_rows: number | string | bigint;
        dead_rows: number | string | bigint;
        seq_scans: number | string | bigint;
        index_scans: number | string | bigint;
        table_bytes: number | string | bigint;
        index_bytes: number | string | bigint;
        total_bytes: number | string | bigint;
        last_vacuum: string | null;
        last_autovacuum: string | null;
        last_analyze: string | null;
        last_autoanalyze: string | null;
      }[]
    >`
      SELECT
        schemaname,
        relname,
        COALESCE(n_live_tup, 0)::bigint AS estimated_rows,
        COALESCE(n_dead_tup, 0)::bigint AS dead_rows,
        COALESCE(seq_scan, 0)::bigint AS seq_scans,
        COALESCE(idx_scan, 0)::bigint AS index_scans,
        pg_relation_size(relid)::bigint AS table_bytes,
        pg_indexes_size(relid)::bigint AS index_bytes,
        pg_total_relation_size(relid)::bigint AS total_bytes,
        last_vacuum::text,
        last_autovacuum::text,
        last_analyze::text,
        last_autoanalyze::text
      FROM pg_stat_user_tables
      ORDER BY schemaname ASC, relname ASC
    `,
    sql<
      {
        name: string;
        default_version: string | null;
        installed_version: string | null;
        comment: string | null;
      }[]
    >`
      SELECT name, default_version, installed_version, comment
      FROM pg_available_extensions
      ORDER BY installed_version IS NULL, name ASC
    `,
  ]);

  const tables = tableRows.map((row) => {
    const base = {
      schema: row.schemaname,
      name: row.relname,
      estimatedRows: toNumber(row.estimated_rows),
      deadRows: toNumber(row.dead_rows),
      seqScans: toNumber(row.seq_scans),
      indexScans: toNumber(row.index_scans),
      tableBytes: toNumber(row.table_bytes),
      indexBytes: toNumber(row.index_bytes),
      totalBytes: toNumber(row.total_bytes),
      lastVacuum: row.last_vacuum,
      lastAutovacuum: row.last_autovacuum,
      lastAnalyze: row.last_analyze,
      lastAutoanalyze: row.last_autoanalyze,
    };
    return { ...base, warnings: tableWarnings(base) };
  });

  const schemaMap = new Map<string, PostgresSchemaDiagnostic>();
  for (const table of tables) {
    const current = schemaMap.get(table.schema) ?? { schema: table.schema, tables: 0, estimatedRows: 0, totalBytes: 0 };
    current.tables += 1;
    current.estimatedRows += table.estimatedRows;
    current.totalBytes += table.totalBytes;
    schemaMap.set(table.schema, current);
  }

  const extensions = extensionRows.map((row) => ({
    name: row.name,
    defaultVersion: row.default_version,
    installedVersion: row.installed_version,
    installed: row.installed_version !== null,
    comment: row.comment,
  }));

  const warnings: DiagnosticWarning[] = [];
  const runtime = {
    maxConnections: toNumber(overview[0]?.max_connections),
    connections: toNumber(overview[0]?.connections),
    activeConnections: toNumber(overview[0]?.active_connections),
    idleInTransaction: toNumber(overview[0]?.idle_in_transaction),
    waitingLocks: toNumber(overview[0]?.waiting_locks),
    oldestWaitingQuerySeconds: toNumber(overview[0]?.oldest_waiting_query_seconds),
    oldestTransactionSeconds: toNumber(overview[0]?.oldest_transaction_seconds),
    oldestIdleTransactionSeconds: toNumber(overview[0]?.oldest_idle_transaction_seconds),
    oldestQuerySeconds: toNumber(overview[0]?.oldest_query_seconds),
    deadlocks: toNumber(overview[0]?.deadlocks),
  };
  const connectionShare = runtime.maxConnections > 0 ? runtime.connections / runtime.maxConnections : 0;
  if (connectionShare >= 0.8) {
    warnings.push({
      area: "postgres",
      tone: connectionShare >= 0.95 ? "red" : "amber",
      title: t.postgresConnectionPressure,
      detail: t.connectionsInUse({ used: formatNumber(runtime.connections, { locale }), total: formatNumber(runtime.maxConnections, { locale }) }),
    });
  }
  if (runtime.waitingLocks > 0) {
    warnings.push({
      area: "postgres",
      tone: runtime.oldestWaitingQuerySeconds >= 30 ? "red" : "amber",
      title: t.queriesWaitingLocks,
      detail: t.waitingLockDetail({ count: formatNumber(runtime.waitingLocks, { locale }), duration: formatDurationMs(runtime.oldestWaitingQuerySeconds * 1000, { locale }) }),
    });
  }
  if (runtime.idleInTransaction > 0 && runtime.oldestIdleTransactionSeconds >= 60) {
    warnings.push({
      area: "postgres",
      tone: "amber",
      title: t.longLivedTransactions,
      detail: t.idleTransactionDetail({ count: formatNumber(runtime.idleInTransaction, { locale }), duration: formatDurationMs(runtime.oldestIdleTransactionSeconds * 1000, { locale }) }),
    });
  }
  const largeTables = tables.filter((table) => table.totalBytes >= LARGE_TABLE_BYTES).length;
  const staleAnalyze = tables.filter((table) => table.estimatedRows > 1_000 && !table.lastAnalyze && !table.lastAutoanalyze).length;
  const deadRows = tables.filter((table) => table.deadRows > 1_000 && table.deadRows > table.estimatedRows * 0.2).length;
  if (largeTables > 0) {
    warnings.push({
      area: "postgres",
      tone: "amber",
      title: t.largePostgresTables,
      detail: t.largeTablesDetail({ count: formatNumber(largeTables, { locale }) }),
    });
  }
  if (staleAnalyze > 0) {
    warnings.push({
      area: "postgres",
      tone: "amber",
      title: t.missingAnalyzeTimestamps,
      detail: t.missingAnalyzeDetail({ count: formatNumber(staleAnalyze, { locale }) }),
    });
  }
  if (deadRows > 0) {
    warnings.push({
      area: "postgres",
      tone: "amber",
      title: t.deadRowPressure,
      detail: t.deadRowDetail({ count: formatNumber(deadRows, { locale }) }),
    });
  }

  return {
    available: true,
    error: null,
    schemas: toNumber(overview[0]?.schemas),
    tables: toNumber(overview[0]?.tables),
    totalBytes: toNumber(overview[0]?.total_bytes),
    installedExtensions: extensions.filter((extension) => extension.installed).length,
    availableExtensions: extensions.length,
    runtime,
    tableRows: tables,
    schemaRows: [...schemaMap.values()].sort((a, b) => b.totalBytes - a.totalBytes),
    extensionRows: extensions,
    warnings,
  };
};

const parseRedisKeyspace = (info: string): RedisKeyspaceDb[] => {
  const rows: RedisKeyspaceDb[] = [];
  for (const line of info.split(/\r?\n/)) {
    const match = /^(db\d+):keys=(\d+),expires=(\d+),avg_ttl=(\d+)/.exec(line.trim());
    if (!match) continue;
    rows.push({
      database: match[1] ?? "db0",
      keys: Number(match[2] ?? 0),
      expires: Number(match[3] ?? 0),
      avgTtlMs: Number(match[4] ?? 0),
    });
  }
  return rows;
};

const prefixForDepth = (key: string, depth: number): string => {
  const parts = key.split(":").filter(Boolean);
  if (parts.length === 0) return key.slice(0, 80) || "(empty)";
  return parts.slice(0, Math.min(depth, parts.length)).join(":");
};

const buildPrefixes = (keys: string[]): RedisPrefixDiagnostic[] => {
  const rows: RedisPrefixDiagnostic[] = [];
  for (const depth of [1, 2, 3]) {
    const counts = new Map<string, number>();
    for (const key of keys) {
      const prefix = prefixForDepth(key, depth);
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    for (const [prefix, count] of counts) {
      rows.push({
        depth,
        prefix,
        count,
        share: keys.length > 0 ? count / keys.length : 0,
      });
    }
  }
  return rows.sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
};

/** `INFO` returns `key:value` lines per section; only the scalars are needed. */
const parseRedisInfo = (raw: string): Map<string, string> => {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return values;
};

const collectRedis = async (locale: string): Promise<RedisDiagnostics> => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  const redis = Bun.redis;
  const [dbSizeRaw, keyspaceInfoRaw, runtimeInfoRaw] = await Promise.all([
    redis.send("DBSIZE", []),
    redis.send("INFO", ["keyspace"]),
    // Keyspace shape alone says nothing about whether Redis is healthy: memory
    // pressure, evictions and a collapsing hit rate are the failures that
    // actually page someone, and none of them were collected.
    redis.send("INFO", ["memory", "stats", "clients", "replication"]).catch(() => ""),
  ]);
  const dbSize = toNumber(dbSizeRaw);
  const keyspace = parseRedisKeyspace(String(keyspaceInfoRaw ?? ""));
  const info = parseRedisInfo(String(runtimeInfoRaw ?? ""));
  const infoNumber = (key: string): number | null => {
    const value = info.get(key);
    if (value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const hits = infoNumber("keyspace_hits");
  const misses = infoNumber("keyspace_misses");
  const runtime = {
    usedMemoryBytes: infoNumber("used_memory"),
    maxMemoryBytes: infoNumber("maxmemory"),
    maxMemoryPolicy: info.get("maxmemory_policy") ?? null,
    evictedKeys: infoNumber("evicted_keys"),
    expiredKeys: infoNumber("expired_keys"),
    connectedClients: infoNumber("connected_clients"),
    blockedClients: infoNumber("blocked_clients"),
    rejectedConnections: infoNumber("rejected_connections"),
    role: info.get("role") ?? null,
    hitRate: hits !== null && misses !== null && hits + misses > 0 ? hits / (hits + misses) : null,
  };

  const sampledKeys: string[] = [];
  let cursor = "0";
  let scanComplete = false;
  for (let scans = 0; scans < 200 && sampledKeys.length < MAX_REDIS_SAMPLE_KEYS; scans += 1) {
    const result = await redis.send("SCAN", [cursor, "COUNT", String(REDIS_SCAN_BATCH)]);
    if (!Array.isArray(result)) break;
    cursor = String(result[0] ?? "0");
    const keys = Array.isArray(result[1]) ? result[1] : [];
    for (const key of keys) {
      if (sampledKeys.length >= MAX_REDIS_SAMPLE_KEYS) break;
      sampledKeys.push(String(key));
    }
    if (cursor === "0") {
      scanComplete = true;
      break;
    }
  }

  const prefixes = buildPrefixes(sampledKeys);
  const expiringKeys = keyspace.reduce((sum, row) => sum + row.expires, 0);
  const knownKeys = keyspace.reduce((sum, row) => sum + row.keys, 0);
  const nonExpiring = Math.max(0, knownKeys - expiringKeys);
  const dominantPrefix = prefixes.find((row) => row.depth === 3 && row.share >= 0.8);

  const warnings: DiagnosticWarning[] = [];
  if (nonExpiring > 0 && knownKeys > 0 && nonExpiring / knownKeys > 0.1) {
    warnings.push({
      area: "redis",
      tone: "amber",
      title: t.redisKeysWithoutExpiry,
      detail: t.redisNoExpiryDetail({ count: formatNumber(nonExpiring, { locale }), total: formatNumber(knownKeys, { locale }) }),
    });
  }
  if (dominantPrefix) {
    warnings.push({
      area: "redis",
      tone: "amber",
      title: t.dominantRedisPrefix,
      detail: t.dominantPrefixDetail({ prefix: dominantPrefix.prefix, share: formatPercent(dominantPrefix.share, { locale }) }),
    });
  }
  if (!scanComplete && dbSize > sampledKeys.length) {
    warnings.push({
      area: "redis",
      tone: "amber",
      title: t.redisPrefixSampled,
      detail: t.sampledKeysDetail({ count: formatNumber(sampledKeys.length, { locale }), total: formatNumber(dbSize, { locale }) }),
    });
  }

  return {
    available: true,
    error: null,
    dbSize,
    sampledKeys: sampledKeys.length,
    scanComplete,
    keyspace,
    prefixes,
    runtime,
    warnings,
  };
};

export const getPostgresDiagnostics = async (locale = "en"): Promise<PostgresDiagnostics> =>
  collectPostgres(locale).catch((error) => emptyPostgres(errorMessage(error), locale));

export const getRedisDiagnostics = async (locale = "en"): Promise<RedisDiagnostics> => collectRedis(locale).catch((error) => emptyRedis(errorMessage(error), locale));

export const getDataDiagnostics = async (locale = "en"): Promise<DataDiagnostics> => {
  const [postgres, redis] = await Promise.all([getPostgresDiagnostics(locale), getRedisDiagnostics(locale)]);
  return { postgres, redis };
};

/** Sessions worth looking at: anything not plainly idle, plus long idles. */
const SESSION_LIMIT = 50;

/**
 * Client backends, most interesting first.
 *
 * Ordered by whether they are blocked, then by transaction age: a session
 * waiting on a lock is the one an operator needs, and a long-open transaction
 * is what stops vacuum from reclaiming anything.
 *
 * `application_name` is included even though Cloud does not set it yet — an
 * unnamed connection is itself the finding, and the column is what makes that
 * visible rather than merely true.
 */
export const listPostgresSessions = async (): Promise<PostgresSession[]> => {
  const rows = await sql<
    {
      pid: number;
      application: string | null;
      usename: string | null;
      state: string | null;
      wait_event_type: string | null;
      wait_event: string | null;
      query_age_seconds: number | null;
      transaction_age_seconds: number | null;
      blocked_by: number[] | null;
      query: string | null;
    }[]
  >`
    SELECT
      pid,
      NULLIF(application_name, '') AS application,
      usename,
      state,
      wait_event_type,
      wait_event,
      EXTRACT(EPOCH FROM (now() - query_start))::float AS query_age_seconds,
      EXTRACT(EPOCH FROM (now() - xact_start))::float AS transaction_age_seconds,
      pg_blocking_pids(pid) AS blocked_by,
      left(query, 500) AS query
    FROM pg_stat_activity
    WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
    ORDER BY
      cardinality(pg_blocking_pids(pid)) DESC,
      xact_start ASC NULLS LAST,
      query_start ASC NULLS LAST
    LIMIT ${SESSION_LIMIT}
  `;
  return rows.map((row) => ({
    pid: row.pid,
    application: row.application,
    user: row.usename,
    state: row.state,
    waitEventType: row.wait_event_type,
    waitEvent: row.wait_event,
    queryAgeSeconds: row.query_age_seconds,
    transactionAgeSeconds: row.transaction_age_seconds,
    blockedBy: row.blocked_by ?? [],
    query: row.query,
  }));
};

const INDEX_LIMIT = 50;

/**
 * Indexes by size, largest first.
 *
 * Index bulk is invisible on a page that reports one total size per table, and
 * it dominates: a table can carry an order of magnitude more index than data.
 * `scans` is cumulative since the last statistics reset, so a zero means "not
 * used since then" — the caller should say so rather than claim the index is
 * unnecessary.
 */
export const listPostgresIndexes = async (): Promise<PostgresIndexDiagnostic[]> => {
  const rows = await sql<
    {
      schemaname: string;
      relname: string;
      indexrelname: string;
      size_bytes: number | string;
      idx_scan: number | string;
      is_unique: boolean;
      is_primary: boolean;
    }[]
  >`
    SELECT
      s.schemaname,
      s.relname,
      s.indexrelname,
      pg_relation_size(s.indexrelid)::bigint AS size_bytes,
      COALESCE(s.idx_scan, 0)::bigint AS idx_scan,
      i.indisunique AS is_unique,
      i.indisprimary AS is_primary
    FROM pg_stat_user_indexes s
    JOIN pg_index i ON i.indexrelid = s.indexrelid
    ORDER BY pg_relation_size(s.indexrelid) DESC
    LIMIT ${INDEX_LIMIT}
  `;
  return rows.map((row) => ({
    schema: row.schemaname,
    table: row.relname,
    name: row.indexrelname,
    sizeBytes: toNumber(row.size_bytes),
    scans: toNumber(row.idx_scan),
    isUnique: row.is_unique,
    isPrimary: row.is_primary,
  }));
};
