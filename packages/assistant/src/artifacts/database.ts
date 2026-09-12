import { sql } from "bun";
import { hasRole } from "@k2b/cloud/contracts";
import { createRsqlClient, type RsqlResult } from "@k2b/rsql";
import { app } from "../config";
import { LIMITS } from "./contracts";
import { DatabaseRequest, DatabaseSettings } from "./database-contracts";
import { safeQuery } from "./database-sql";
import { requireArtifact, user, type ArtifactIdentity } from "./service";

export class DatabaseError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 409 | 502 = 400) { super(code); }
}
function admin(identity: ArtifactIdentity) {
  if (!hasRole(user(identity),"admin")) throw new DatabaseError("ACCESS_DENIED",403);
}
async function config() {
  return {url:await app.settings.get("assistant.rsql_url"),token:await app.settings.get("assistant.rsql_api_token")};
}
export const databaseConfigLock = (db: typeof sql) => db`SELECT pg_advisory_xact_lock_shared(hashtext('assistant-rsql-settings'))`;
function connection(c: { url: string; token: string }, signal?: AbortSignal, streaming = false) {
  if (!c.url || !c.token) throw new DatabaseError("DB_NOT_CONFIGURED", 409);
  const address = new URL(c.url);
  if (!["http:", "https:"].includes(address.protocol) || address.username || address.password || address.search || address.hash)
    throw new DatabaseError("INVALID_INPUT");
  return createRsqlClient({
    url: c.url.replace(/\/$/, ""),
    token: c.token,
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const deadline=new AbortController();
        const timer=streaming?setTimeout(()=>deadline.abort(),15000):undefined;
        const timeout = streaming?deadline.signal:AbortSignal.timeout(15000);
        let response: Response;
        try {
          response = await fetch(input, {
            ...init,
            redirect: "error",
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          throw new DatabaseError(timeout.aborted ? "DB_TIMEOUT" : "DB_UNREACHABLE", 502);
        } finally {clearTimeout(timer);}
        if (!response.body || !response.headers.get("content-type")?.includes("json")) return response;
        let bytes = 0;
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytes += chunk.byteLength;
              if (bytes > LIMITS.rpcBytes) throw new DatabaseError("DB_LIMIT");
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
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) throw new DatabaseError("DB_AUTH_FAILED", 502);
    throw new DatabaseError(r.error.error, r.status === 409 ? 409 : 400);
  }
  return r.data;
}
const generation=(namespace:string)=>new Bun.CryptoHasher("sha256").update(namespace).digest("hex");
export const artifactDatabase = {
  async status(id: string, identity: ArtifactIdentity, signal?: AbortSignal) {
    return sql.begin(async db => {
      await databaseConfigLock(db);
      await requireArtifact(db, id, identity, "admin");
      const c = await config();
      const [mapping] = await db<{namespace:string;connected:boolean}[]>`SELECT namespace,connected FROM assistant.artifact_databases WHERE artifact_id=${id}::uuid`;
      const configured = Boolean(c.url && c.token);
      let overview=null, unavailable:string|null=null;
      if(configured&&mapping?.connected){
        try{overview=result(await connection(c,signal).ns(mapping.namespace).overview.get());}
        catch(error){if(signal?.aborted)throw error;unavailable=error instanceof DatabaseError?error.code:"DB_UNREACHABLE";}
      }
      return {configured, connected: mapping?.connected ?? false, generation:mapping?generation(mapping.namespace):null, overview, unavailable};
    });
  },
  async reset(id: string, expectedGeneration: string | null, identity: ArtifactIdentity) {
    return sql.begin(async db => {
      await databaseConfigLock(db);
      await requireArtifact(db, id, identity, "admin");
      const [mapping]=await db<{namespace:string}[]>`SELECT namespace FROM assistant.artifact_databases WHERE artifact_id=${id}::uuid`;
      if(mapping&&generation(mapping.namespace)!==expectedGeneration)throw new DatabaseError("CONFLICT",409);
      await db`INSERT INTO assistant.database_cleanup(namespace)
        SELECT namespace FROM assistant.artifact_databases WHERE artifact_id=${id}::uuid ON CONFLICT DO NOTHING`;
      await db`DELETE FROM assistant.artifact_databases WHERE artifact_id=${id}::uuid`;
      return {connected:false};
    });
  },
  async export(id: string, identity: ArtifactIdentity, signal?: AbortSignal) {
    return sql.begin(async db => {
      await databaseConfigLock(db);
      await requireArtifact(db, id, identity, "admin");
      const [mapping] = await db<{namespace:string;connected:boolean}[]>`SELECT namespace,connected FROM assistant.artifact_databases WHERE artifact_id=${id}::uuid`;
      if (!mapping?.connected) throw new DatabaseError("DB_NOT_CONNECTED",409);
      // Keep the response streaming; a database backup is not a bounded JSON RPC.
      return result(await connection(await config(),signal,true).namespaces.exportDb(mapping.namespace));
    });
  },
  async settings(identity: ArtifactIdentity) {
    admin(identity); const c=await config(); return {url:c.url,tokenSet:Boolean(c.token)};
  },
  async configure(input: unknown, identity: ArtifactIdentity, testOnly=false) {
    admin(identity); const next=DatabaseSettings.parse(input);
    return sql.begin(async db => {
      await db`SELECT pg_advisory_xact_lock(hashtext('assistant-rsql-settings'))`;
      const current=await config(), token=next.token ?? current.token;
      if (!testOnly && (next.url !== current.url || !token)) {
        const [used]=await db<{count:number}[]>`SELECT ((SELECT count(*) FROM assistant.artifact_databases)+(SELECT count(*) FROM assistant.database_cleanup))::int AS count`;
        if (used?.count) throw new DatabaseError("DB_SERVER_IN_USE",409);
      }
      if (next.url || token) result(await connection({url:next.url,token}).namespaces.list({limit:1}));
      if (testOnly) return {connected:true};
      await app.settings.set("assistant.rsql_url",next.url);
      if (next.token !== undefined) await app.settings.set("assistant.rsql_api_token",next.token);
      return {url:next.url,tokenSet:Boolean(token)};
    });
  },
  async connect(id: string, identity: ArtifactIdentity, signal?: AbortSignal) {
    // Persist the intended namespace before any remote effect. A failed call
    // can be retried, and deletion can always find a partially created DB.
    await sql.begin(async db => {
      await databaseConfigLock(db);
      await requireArtifact(db,id,identity,"read");
      connection(await config(),signal);
      await db`INSERT INTO assistant.artifact_databases(artifact_id,namespace)
        VALUES(${id}::uuid,${"assistant_"+crypto.randomUUID().replaceAll("-","")}) ON CONFLICT DO NOTHING`;
    });
    return sql.begin(async db => {
      await databaseConfigLock(db);
      await requireArtifact(db,id,identity,"read");
      const [mapping]=await db<{namespace:string;connected:boolean}[]>`SELECT * FROM assistant.artifact_databases WHERE artifact_id=${id}::uuid`;
      if (!mapping) throw new DatabaseError("DB_NOT_CONNECTED",409);
      if (!mapping.connected) {
        const client=connection(await config(),signal);
        const created=await client.namespaces.create({name:mapping.namespace});
        if (!created.ok && created.status !== 409) result(created);
        result(await client.ns(mapping.namespace).overview.get());
        await db`UPDATE assistant.artifact_databases SET connected=true WHERE artifact_id=${id}::uuid`;
      }
      return {connected:true};
    });
  },
  async call(id: string, input: unknown, identity: ArtifactIdentity, signal?: AbortSignal, management = false) {
    const req=DatabaseRequest.parse(input);
    if(management && !["tables.list","schema.get","rows.list","query"].includes(req.operation)) throw new DatabaseError("DB_SQL_UNSUPPORTED");
    return sql.begin(async db => {
      await databaseConfigLock(db);
      await requireArtifact(db,id,identity,management || (req.operation.startsWith("tables.") && req.operation !== "tables.list") ? "admin" : "read");
      const c=await config(); connection(c,signal);
      const [mapping]=await db<{namespace:string;connected:boolean}[]>`SELECT * FROM assistant.artifact_databases WHERE artifact_id=${id}::uuid`;
      if (!mapping?.connected) throw new DatabaseError("DB_NOT_CONNECTED",409);
      const client=connection(c,signal).ns(mapping.namespace);
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
          const page = result(await client.table(req.table).rows.list({ ...req.query, limit }));
          data = { ...page, data: page.data ?? [] };
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
            query = safeQuery(req.sql, req.params.length);
          } catch (error) {
            throw new DatabaseError(error instanceof Error && error.message === "DB_SQL_PARAMS" ? "DB_SQL_PARAMS" : "DB_SQL_UNSUPPORTED");
          }
          data = result(await client.query.run({ sql: query, params: req.params }));
          // rsql 1.0 returns null for an empty Go result slice. The runtime's
          // row collection remains an array, including before the first import.
          if (data && typeof data === "object" && "data" in data && data.data === null) data = {...data,data:[]};
          break;
        }
      }
      if (data && typeof data === "object" && "data" in data && Array.isArray(data.data) && data.data.length > LIMITS.rows)
        throw new DatabaseError("DB_LIMIT");
      if (new TextEncoder().encode(JSON.stringify(data ?? null)).length > LIMITS.rpcBytes) throw new DatabaseError("DB_LIMIT");
      return data ?? null;
    });
  },
  async cleanup() {
    return sql.begin(async db => {
      await databaseConfigLock(db);
      const [item]=await db<{namespace:string}[]>`SELECT namespace FROM assistant.database_cleanup ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (!item) return;
      const removed=await connection(await config()).namespaces.delete(item.namespace);
      if (!removed.ok && removed.status !== 404) result(removed);
      await db`DELETE FROM assistant.database_cleanup WHERE namespace=${item.namespace}`;
    });
  },
};
