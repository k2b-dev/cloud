import { sql } from "bun";
import { hasRole } from "@k2b/cloud/contracts";
import { createRsqlClient, type RsqlResult } from "@k2b/rsql";
import { app } from "../config";
import { LIMITS } from "../contracts";
import { DatabaseRequest, DatabaseSettings } from "../database-contracts";
import { safeQuery } from "../database-sql";
import { requireProject, user, type Identity } from "./index";

export class DatabaseError extends Error {
  constructor(
    public code: string,
    public status: 400 | 403 | 409 | 502 = 400,
  ) {
    super(code);
  }
}
type Db = typeof sql;
type Mapping = {
  project_id: string;
  enabled: boolean;
  namespace: string | null;
  pending_namespace: string | null;
  generation: number;
  error: string | null;
};
export function requireAdmin(identity: Identity) {
  if (!hasRole(user(identity), "admin")) throw new DatabaseError("ACCESS_DENIED", 403);
}
async function config() {
  return {
    enabled: await app.settings.get("kit.rsql_enabled"),
    url: await app.settings.get("kit.rsql_url"),
    token: await app.settings.get("kit.rsql_api_token"),
  };
}
function connection(c: { url: string; token: string }, signal?: AbortSignal) {
  if (!c.url || !c.token) throw new DatabaseError("DB_NOT_CONFIGURED", 409);
  const address = new URL(c.url);
  if (!["http:", "https:"].includes(address.protocol) || address.username || address.password || address.search || address.hash)
    throw new DatabaseError("INVALID_INPUT");
  return createRsqlClient({
    url: c.url.replace(/\/$/, ""),
    token: c.token,
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await fetch(input, {
          ...init,
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        });
        if (!response.body || !response.headers.get("content-type")?.includes("json")) return response;
        let bytes = 0;
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytes += chunk.byteLength;
              if (bytes > 16 * 1024 * 1024) throw new DatabaseError("DB_LIMIT");
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      },
      { preconnect: fetch.preconnect },
    ),
  });
}
function result<T>(r: RsqlResult<T>): T {
  if (!r.ok) throw new DatabaseError(r.error.error, r.status === 403 || r.status === 401 ? 502 : r.status === 409 ? 409 : 400);
  return r.data;
}
// Coordinate configuration with lifecycle/data calls across Kit processes.
const sharedConfig = (db: Db) => db`SELECT pg_advisory_xact_lock_shared(hashtext('kit-rsql-settings'))`;
const exclusiveConfig = (db: Db) => db`SELECT pg_advisory_xact_lock(hashtext('kit-rsql-settings'))`;
export async function enqueueDatabaseCleanup(db: Db, projectId: string) {
  const [m] = await db<Mapping[]>`SELECT * FROM kit.project_databases WHERE project_id=${projectId}::uuid FOR UPDATE`;
  for (const namespace of [m?.namespace, m?.pending_namespace])
    if (namespace) await db`INSERT INTO kit.database_cleanup(namespace) VALUES(${namespace}) ON CONFLICT DO NOTHING`;
}
export const database = {
  async settings(identity: Identity) {
    requireAdmin(identity);
    const c = await config();
    return { enabled: c.enabled, url: c.url, tokenSet: Boolean(c.token) };
  },
  async configure(input: unknown, identity: Identity) {
    requireAdmin(identity);
    const next = DatabaseSettings.parse(input);
    return sql.begin(async (db) => {
      await exclusiveConfig(db);
      const current = await config();
      if (next.url !== current.url || next.token === "") {
        const [count] = await db<
          { n: number }[]
        >`SELECT ((SELECT count(*) FROM kit.project_databases WHERE namespace IS NOT NULL OR pending_namespace IS NOT NULL)+(SELECT count(*) FROM kit.database_cleanup))::int AS n`;
        if (count?.n) throw new DatabaseError("DB_SERVER_IN_USE", 409);
      }
      const token = next.token ?? current.token;
      if (next.url) connection({ url: next.url, token: token || "validation" });
      if (next.enabled) result(await connection({ url: next.url, token }).namespaces.list({ limit: 1 }));
      // Disable first; never expose a partially updated enabled configuration.
      await app.settings.set("kit.rsql_enabled", false);
      await app.settings.set("kit.rsql_url", next.url);
      if (next.token !== undefined) await app.settings.set("kit.rsql_api_token", next.token);
      await app.settings.set("kit.rsql_enabled", next.enabled);
      return { enabled: next.enabled, url: next.url, tokenSet: Boolean(token) };
    });
  },
  async test(input: unknown, identity: Identity) {
    requireAdmin(identity);
    const next = DatabaseSettings.parse(input),
      current = await config();
    result(await connection({ url: next.url, token: next.token ?? current.token }).namespaces.list({ limit: 1 }));
    return { connected: true };
  },
  async status(id: string, identity: Identity, diagnostics = false) {
    return sql.begin(async (db) => {
      await sharedConfig(db);
      const { row, level } = await requireProject(db, id, identity, "write");
      const [m] = await db<Mapping[]>`SELECT * FROM kit.project_databases WHERE project_id=${row.id}::uuid FOR SHARE`;
      const c = await config();
      const status = !c.enabled ? "globally_disabled" : m?.pending_namespace ? "provisioning" : !m?.enabled ? "disabled" : "ready";
      const base = {
        enabled: m?.enabled ?? false,
        globallyEnabled: c.enabled,
        provisioned: Boolean(m?.namespace),
        generation: m?.generation ?? 0,
        status,
        canAdmin: level === "admin",
        error: m?.error ?? null,
      };
      if (!diagnostics || !c.enabled || !m?.namespace || m.pending_namespace) return { ...base, overview: null, tables: null };
      try {
        const client = connection(c).ns(m.namespace);
        const overview = result(await client.overview.get());
        const tables = result(await client.tables.list());
        return { ...base, overview, tables };
      } catch {
        return { ...base, status: "unavailable", overview: null, tables: null, error: "DB_UNAVAILABLE" };
      }
    });
  },
  async enable(id: string, enabled: boolean, identity: Identity, reset = false) {
    await sql.begin(async (db) => {
      await sharedConfig(db);
      const { row } = await requireProject(db, id, identity, "admin", true);
      const c = await config();
      if (!c.enabled) throw new DatabaseError("DB_GLOBALLY_DISABLED", 409);
      await db`INSERT INTO kit.project_databases(project_id) VALUES(${row.id}::uuid) ON CONFLICT DO NOTHING`;
      const [m] = await db<Mapping[]>`SELECT * FROM kit.project_databases WHERE project_id=${row.id}::uuid FOR UPDATE`;
      if (!m) throw new DatabaseError("NOT_FOUND");
      if (m.pending_namespace) throw new DatabaseError("DB_TRANSITION", 409);
      if (reset && !m.namespace) throw new DatabaseError("DB_DISABLED", 409);
      const pending = reset || (enabled && !m.namespace) ? `kit_${row.short_id}_${crypto.randomUUID().replaceAll("-", "")}` : null;
      await db`UPDATE kit.project_databases SET enabled=${reset ? m.enabled : enabled}, pending_namespace=${pending}, error=NULL, updated_at=now() WHERE project_id=${row.id}::uuid`;
    });
    await database.reconcile(id);
    return database.status(id, identity);
  },
  async call(id: string, generation: number, input: unknown, identity: Identity, signal?: AbortSignal) {
    const req = DatabaseRequest.parse(input);
    return sql.begin(async (db) => {
      await sharedConfig(db);
      const { row } = await requireProject(
        db,
        id,
        identity,
        req.operation.startsWith("tables.") && req.operation !== "tables.list" ? "admin" : "write",
      );
      const [m] = await db<Mapping[]>`SELECT * FROM kit.project_databases WHERE project_id=${row.id}::uuid FOR SHARE`;
      const c = await config();
      if (!c.enabled) throw new DatabaseError("DB_GLOBALLY_DISABLED", 409);
      if (!m?.enabled || !m.namespace) throw new DatabaseError("DB_DISABLED", 409);
      if (m.pending_namespace || generation !== m.generation) throw new DatabaseError("DB_STALE", 409);
      const client = connection(c, signal).ns(m.namespace);
      let data: unknown;
      switch (req.operation) {
        case "tables.list":
          data = result(await client.tables.list());
          break;
        case "tables.create":
          data = result(await client.tables.create({ type: "table", name: req.name, columns: req.columns }));
          break;
        case "tables.update":
          data = result(await client.tables.update(req.table, req.changes));
          break;
        case "tables.delete":
          data = result(await client.tables.delete(req.table));
          break;
        case "schema.get":
          data = result(await client.tables.get(req.table));
          break;
        case "rows.list": {
          const limit = Number(req.query.limit ?? 50);
          if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.rows) throw new DatabaseError("DB_LIMIT");
          data = result(await client.table(req.table).rows.list({ ...req.query, limit }));
          break;
        }
        case "rows.get":
          data = result(await client.table(req.table).rows.get(req.id));
          break;
        case "rows.insert":
          data = result(await client.table(req.table).rows.insert(req.rows));
          break;
        case "rows.update":
          data = result(await client.table(req.table).rows.update(req.id, req.row));
          break;
        case "rows.delete":
          data = result(await client.table(req.table).rows.delete(req.id));
          break;
        case "query": {
          let query: string;
          try {
            query = safeQuery(req.sql);
          } catch {
            throw new DatabaseError("DB_SQL_UNSUPPORTED");
          }
          data = result(await client.query.run({ sql: query, params: req.params }));
          break;
        }
      }
      if (data && typeof data === "object" && "data" in data && Array.isArray(data.data) && data.data.length > LIMITS.rows)
        throw new DatabaseError("DB_LIMIT");
      if (new TextEncoder().encode(JSON.stringify(data ?? null)).length > LIMITS.rpcBytes) throw new DatabaseError("DB_LIMIT");
      return data ?? null;
    });
  },
  async export(id: string, identity: Identity) {
    // The response is a stream; rsql's export is already a consistent snapshot.
    return sql.begin(async (db) => {
      await sharedConfig(db);
      const { row } = await requireProject(db, id, identity, "admin");
      const [m] = await db<Mapping[]>`SELECT * FROM kit.project_databases WHERE project_id=${row.id}::uuid FOR SHARE`;
      const c = await config();
      if (!c.enabled) throw new DatabaseError("DB_GLOBALLY_DISABLED", 409);
      if (!m?.namespace || m.pending_namespace) throw new DatabaseError("DB_DISABLED", 409);
      return result(await connection(c).namespaces.exportDb(m.namespace));
    });
  },
  async reconcile(target?: string) {
    await sql.begin(async (db) => {
      await sharedConfig(db);
      // Skip overlapping ticks/processes; durable rows remain the source of truth.
      const [lock] = await db<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('kit-rsql-reconcile')) AS locked`;
      if (!lock?.locked) return;
      const c = await config();
      if (!c.url || !c.token) return;
      const client = connection(c);
      if (c.enabled) {
        const rows = await db<
          Mapping[]
        >`SELECT * FROM kit.project_databases WHERE pending_namespace IS NOT NULL AND (${target ?? null}::text IS NULL OR project_id=(SELECT id FROM kit.projects WHERE short_id=${target ?? null})) ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
        for (const m of rows) {
          try {
            const created = await client.namespaces.create({ name: m.pending_namespace! });
            if (!created.ok && created.status !== 409) result(created);
            // A retry can observe the namespace created before a previous transaction failed.
            result(await client.ns(m.pending_namespace!).overview.get());
            if (m.namespace) await db`INSERT INTO kit.database_cleanup(namespace) VALUES(${m.namespace}) ON CONFLICT DO NOTHING`;
            await db`UPDATE kit.project_databases SET namespace=pending_namespace,pending_namespace=NULL,generation=generation+1,error=NULL,updated_at=now() WHERE project_id=${m.project_id}::uuid`;
          } catch {
            await db`UPDATE kit.project_databases SET error='DB_UNAVAILABLE',updated_at=now() WHERE project_id=${m.project_id}::uuid`;
          }
        }
      }
      if (target) return;
      const cleanup = await db<
        { namespace: string }[]
      >`SELECT namespace FROM kit.database_cleanup ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
      for (const item of cleanup) {
        try {
          const removed = await client.namespaces.delete(item.namespace);
          if (!removed.ok && removed.status !== 404) result(removed);
          await db`DELETE FROM kit.database_cleanup WHERE namespace=${item.namespace}`;
        } catch {
          await db`UPDATE kit.database_cleanup SET error='DB_UNAVAILABLE',created_at=now() WHERE namespace=${item.namespace}`;
        }
      }
    });
  },
};
