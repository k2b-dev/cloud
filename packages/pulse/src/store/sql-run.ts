import { z } from "zod";
import { SqlError } from "../service/sql-errors";
import { prepareSql } from "../sql-params";
import type { ReadProfileName } from "./admin-contracts";
import { baseStore, type createBaseStore } from "./base-store";
import { clickhouseQuery, clickhouseResponse, type QueryOptions, StoreQueryError, StoreResponseTooLarge } from "./client";
import { storeConnection } from "./service";
import { READ_LIMITS, READ_PROFILES } from "./setup-sql";

export type SqlRows = {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  stats: { elapsedMs: number; readRows: number; readBytes: number; memoryBytes?: number };
};
const Output = z.object({
  meta: z.array(z.object({ name: z.string(), type: z.string() })),
  data: z.array(z.array(z.unknown())),
  statistics: z.object({ elapsed: z.number(), rows_read: z.number(), bytes_read: z.number() }).optional(),
});
// Profile wall-time limit + 2 s for HTTP delivery; leases budget another 5 s for KILL.
export const SQL_HTTP_MARGIN_MS = 2_000;
export const sqlQueryId = (baseId: string, runId: string) => `pulse_sql_${baseId.replaceAll("-", "")}_${runId}`;
export const scrubSqlMessage = (message: string, own: { database: string; user: string; password?: string }) => {
  // Database/user identifiers are server-owned, never return tenant names. The
  // general pattern also catches test/operator prefixes and names in nested errors.
  let result = message.replace(/[A-Za-z_][A-Za-z0-9_]*?(?:r_)?[a-f0-9]{32}\b/gi, "[base]");
  for (const value of [own.database, own.user, own.password]) if (value) result = result.split(value).join("[base]");
  // ClickHouse sometimes echoes the whole failed query (including literals).
  // Keep the diagnostic, discard echoed SQL and exception/version boilerplate.
  return result
    .replace(/\s*(?:\(query:|Query:)[\s\S]*$/i, "")
    .replace(/\s*\(version [^)]+\)\s*$/i, "")
    .slice(0, 2048);
};
export const mapSqlStoreError = (
  error: unknown,
  own: { database: string; user: string; password?: string },
  signal?: AbortSignal,
  timeout?: AbortSignal,
): SqlError => {
  if (signal?.aborted) return new SqlError("CANCELLED", "Query cancelled");
  if (timeout?.aborted) return new SqlError("TIME_LIMIT", "The query time limit was reached");
  if (error instanceof StoreResponseTooLarge) return new SqlError("RESULT_TOO_LARGE", "The result exceeds the response size limit");
  if (error instanceof StoreQueryError && error.kind === "clickhouse") {
    const raw = error.clickhouseMessage ?? `ClickHouse error ${error.code}`;
    const message = scrubSqlMessage(raw, own);
    if (error.code === 159) return new SqlError("TIME_LIMIT", message);
    if (error.code === 241) return new SqlError("MEMORY_LIMIT", message);
    if (error.code === 396) return new SqlError("RESULT_TOO_LARGE", message);
    if (error.code === 394) return new SqlError("CANCELLED", "Query cancelled");
    const location = /line\s+(\d+)(?:,?\s*col(?:umn)?\s+(\d+))?/i.exec(message);
    // The wrapper adds exactly one line; retain user columns unchanged.
    const line = location ? Math.max(1, Number(location[1]) - 1) : undefined;
    const column = location?.[2] ? Number(location[2]) : undefined;
    const adjusted = location ? message.replace(location[0], `line ${line}${column ? `, column ${column}` : ""}`) : message;
    return new SqlError("SQL_ERROR", adjusted, { line, column });
  }
  return new SqlError("STORE_UNAVAILABLE", "The Pulse data store is unavailable. Retry later.");
};
export const createSqlRunner = ({
  store = baseStore,
  connection = storeConnection,
  transport,
}: {
  store?: ReturnType<typeof createBaseStore>;
  connection?: typeof storeConnection;
  transport?: QueryOptions["transport"];
} = {}) => ({
  async kill(baseId: string, runId: string) {
    const config = await connection();
    if (!config) throw new SqlError("STORE_UNAVAILABLE", "The Pulse data store is unavailable");
    const credentials = await store.readUserCredentials(baseId);
    // Both predicates are essential: a crafted id belonging to another reader
    // must survive this request. Never use the admin's user or a SQL-chosen user.
    await clickhouseQuery({
      ...config,
      transport,
      query: "KILL QUERY WHERE query_id = {q:String} AND user = {u:String} SYNC",
      params: { q: sqlQueryId(baseId, runId), u: credentials.user },
      timeoutMs: 5_000,
    });
  },
  async run(input: {
    baseId: string;
    database: string;
    profile: ReadProfileName;
    timezone: string;
    sql: string;
    params?: Record<string, string>;
    runId: string;
    signal?: AbortSignal;
  }): Promise<SqlRows> {
    const prepared = prepareSql(input.sql, input.params, input.timezone);
    const config = await connection();
    if (!config) throw new SqlError("STORE_UNAVAILABLE", "The Pulse data store is unavailable");
    const credentials = await store.readUserCredentials(input.baseId);
    const timeoutMs = READ_PROFILES[`read_${input.profile}`].max_execution_time * 1000 + SQL_HTTP_MARGIN_MS;
    const timeout = AbortSignal.timeout(timeoutMs),
      signal = AbortSignal.any([timeout, ...(input.signal ? [input.signal] : [])]);
    try {
      const response = await clickhouseResponse({
        ...config,
        ...credentials,
        transport,
        query: `SELECT * FROM (\n${prepared.sql}\n) LIMIT ${READ_LIMITS.max_result_rows}`,
        params: prepared.params,
        database: input.database,
        queryId: sqlQueryId(input.baseId, input.runId),
        signal,
        timeoutMs,
        maxResponseBytes: READ_LIMITS.max_result_bytes + 1024 * 1024,
        format: "JSONCompact",
      });
      const result = Output.parse(JSON.parse(response.text));
      if (new TextEncoder().encode(JSON.stringify(result.data)).byteLength > READ_LIMITS.max_result_bytes)
        throw new SqlError("RESULT_TOO_LARGE", "The result exceeds 4 MiB");
      let summary: Record<string, unknown> = {};
      try {
        const value: unknown = JSON.parse(response.headers.get("X-ClickHouse-Summary") ?? "{}");
        if (value && typeof value === "object" && !Array.isArray(value)) summary = value as Record<string, unknown>;
      } catch {
        /* Optional server summary. */
      }
      const finite = (value: unknown, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
      const memory = summary.memory_usage ?? summary.peak_memory_usage;
      return {
        columns: result.meta,
        rows: result.data,
        rowCount: result.data.length,
        // max_result_rows uses overflow_mode=throw: LIMIT n+1 would fail.
        // Exactly n means the limit was reached; there may be more rows.
        truncated: result.data.length === READ_LIMITS.max_result_rows,
        stats: {
          elapsedMs: finite(summary.elapsed_ns, (result.statistics?.elapsed ?? 0) * 1e9) / 1e6,
          readRows: finite(summary.read_rows, result.statistics?.rows_read),
          readBytes: finite(summary.read_bytes, result.statistics?.bytes_read),
          ...(memory !== undefined && Number.isFinite(Number(memory)) ? { memoryBytes: Number(memory) } : {}),
        },
      };
    } catch (error) {
      if (error instanceof SqlError) throw error;
      if (signal.aborted) await this.kill(input.baseId, input.runId).catch(() => {});
      throw mapSqlStoreError(error, { database: input.database, ...credentials }, input.signal, timeout);
    }
  },
});
export const sqlRunner = createSqlRunner();
