import { CodeBridgeRefusal } from "@k2b/cloud/api";
import { CODE_DATABASE_LIMITS, type CodeDatabaseRequest } from "@k2b/cloud/code";
import { createAllowedNetworkFetch } from "@k2b/cloud/services";
import { parseNetworkAllowlistEnv } from "@k2b/cloud/shared";
import { createRsqlClient, type RsqlResult } from "@k2b/rsql";
import { z } from "zod";

export type CodeRsqlConfig = { url: string; token: string; allowedTargets: string[] };
export type CodeDatabaseClient = {
  create(namespace: string, bytes: number, timeoutMs: number): Promise<void>;
  configure(namespace: string, bytes: number, timeoutMs: number): Promise<void>;
  execute(namespace: string, request: CodeDatabaseRequest): Promise<unknown>;
  size(namespace: string): Promise<number>;
  remove(namespace: string): Promise<void>;
};
const refuse = (code: string): never => {
  throw new CodeBridgeRefusal(code);
};
export function codeRsqlResult<T>(result: RsqlResult<T>): T {
  if (result.ok) return result.data;
  const code = result.error.error.toLowerCase();
  if (["quota_exceeded", "database_full"].includes(code)) return refuse("code_db_full");
  if (["sql_timeout", "query_timeout", "statement_timeout", "timeout"].includes(code)) return refuse("code_db_timeout");
  if (code === "sql_limit_exceeded") return refuse("code_db_limit");
  if (result.status === 401 || result.status === 403 || result.status === 404 || result.status >= 500) return refuse("code_db_unavailable");
  return refuse("code_db_sql");
}
/** The only RSQL-specific adapter. Namespaces and credentials originate in Core, never the bundle. */
export function createCodeDatabaseClient(config: CodeRsqlConfig, signal?: AbortSignal): CodeDatabaseClient {
  if (!config.url || !config.token) return refuse("code_db_unavailable");
  const request = createAllowedNetworkFetch(parseNetworkAllowlistEnv("core.code.rsql_allowed_targets", config.allowedTargets));
  const client = createRsqlClient({
    url: config.url,
    token: config.token,
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const timeout = AbortSignal.timeout(CODE_DATABASE_LIMITS.statementMs);
        const signals = [timeout, ...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : [])];
        try {
          const response = await request(input, { ...init, redirect: "error", signal: AbortSignal.any(signals) });
          if (!response.body) return response;
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > CODE_DATABASE_LIMITS.resultBytes) return refuse("code_db_limit");
              chunks.push(chunk.value);
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
        } catch (error) {
          if (error instanceof CodeBridgeRefusal) throw error;
          const expired =
            timeout.aborted || (signal?.aborted && signal.reason instanceof DOMException && signal.reason.name === "TimeoutError");
          return refuse(expired ? "code_db_timeout" : "code_db_unavailable");
        }
      },
      { preconnect: () => {} },
    ),
  });
  const configuration = (bytes: number, timeoutMs: number) => ({
    journal_mode: "wal",
    busy_timeout: Math.min(timeoutMs, 5000),
    query_timeout: timeoutMs,
    max_db_size: bytes,
    foreign_keys: true,
  });
  return {
    async create(namespace, bytes, timeoutMs) {
      const created = await client.namespaces.create({ name: namespace, config: configuration(bytes, timeoutMs) });
      // A previous attempt may have created it before losing the response. The persisted intent owns this exact name.
      if (!created.ok && created.status !== 409) codeRsqlResult(created);
    },
    async configure(namespace, bytes, timeoutMs) {
      codeRsqlResult(await client.namespaces.update(namespace, configuration(bytes, timeoutMs)));
    },
    async execute(namespace, input) {
      const query = client.ns(namespace).query;
      if (input.operation === "db.query") {
        const result = z
          .object({ data: z.array(z.record(z.string(), z.json())).nullable() })
          .safeParse(codeRsqlResult(await query.run({ sql: input.sql, params: input.params })));
        if (!result.success) return refuse("code_db_unavailable");
        return result.data.data ?? [];
      }
      if (input.operation === "db.exec") {
        const result = codeRsqlResult(await query.exec({ sql: input.sql, params: input.params }));
        const decoded = z.object({ changes: z.number().int().nonnegative() }).safeParse(result);
        return decoded.success ? decoded.data : refuse("code_db_unavailable");
      }
      const result = codeRsqlResult(await query.transaction(input.statements));
      const decoded = z.object({ results: z.array(z.object({ changes: z.number().int().nonnegative() })) }).safeParse(result);
      return decoded.success ? decoded.data.results : refuse("code_db_unavailable");
    },
    async size(namespace) {
      const result = codeRsqlResult(await client.ns(namespace).overview.get());
      return z.object({ storage: z.object({ used_bytes: z.number().nonnegative() }) }).parse(result).storage.used_bytes;
    },
    async remove(namespace) {
      const result = await client.namespaces.delete(namespace);
      if (!result.ok && result.status !== 404) codeRsqlResult(result);
    },
  };
}
