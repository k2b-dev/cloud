import { sql } from "@k2b/cloud";
import { type CodeBridgeCall, CodeBridgeRefusal } from "@k2b/cloud/api";
import { CODE_DATABASE_LIMITS, type CodeDatabaseRequest } from "@k2b/cloud/code";
import type { CodeRunTokenClaims } from "@k2b/cloud/code/run-token";
import { canRepairAppAccess } from "@k2b/cloud/services";
import type { SQL } from "bun";
import { type CodeContext, codePerson } from "./access";
import { authorizeCodeCall } from "./bridge";
import { CodeIdSchema } from "./contracts";
import { codeDatabaseOwnerCapacity, reserveCodeDatabaseCapacity } from "./database-budget";
import { createCodeDatabaseClient } from "./database-client";
import { readDatabaseDeadline } from "./database-deadline";
import { codeDatabaseSettings } from "./database-settings";
import { codeSettings } from "./settings";
import { readCode } from "./store";

export const codeDatabaseNamespace = (codeId: string) => `code_${CodeIdSchema.parse(codeId)}`;
export async function readCodeDatabaseConfig() {
  try {
    const url = await codeDatabaseSettings.read("core.code.rsql_url");
    const token = await codeDatabaseSettings.read("core.code.rsql_api_token");
    const targets = await codeDatabaseSettings.read("core.code.rsql_allowed_targets");
    if ([url, token, targets].some((state) => state.stored === "unreadable") || !url.value || !token.value)
      throw new CodeBridgeRefusal("code_db_unavailable", 503);
    return { url: new URL(url.value).toString().replace(/\/+$/, ""), token: token.value, allowedTargets: targets.value };
  } catch {
    throw new CodeBridgeRefusal("code_db_unavailable", 503);
  }
}
type Mapping = { namespace: string; connected: boolean; server_url: string };
const sameServer = (mapping: Mapping, url: string) => {
  if (mapping.server_url !== url) throw new CodeBridgeRefusal("code_db_unavailable", 503);
};

/** Admit in short transactions; SQL execution must never hold Core locks or a pool connection. */
export async function dispatchCodeDatabase(
  input: { claims: CodeRunTokenClaims; request: CodeDatabaseRequest; signal: AbortSignal },
  factory: typeof createCodeDatabaseClient = createCodeDatabaseClient,
): Promise<Response> {
  const call: CodeBridgeCall = {
    claims: input.claims,
    kind: "database",
    call: { capability: input.request.operation, target: null, refs: {}, input: input.request },
  };
  const config = await readCodeDatabaseConfig();
  const namespace = `${codeDatabaseNamespace(input.claims.codeId)}_${crypto.randomUUID().replaceAll("-", "")}`;
  const bytes = await codeSettings.get("core.code.database_bytes");
  const ownerLimit = await codeSettings.get("core.code.database_owner_bytes");
  const prepared = await sql.begin(async (tx) => {
    await authorizeCodeCall(call, tx);
    const capacity = await reserveCodeDatabaseCapacity(tx, input.claims.codeId, bytes, ownerLimit, input.request.operation !== "db.query");
    let [mapping] = await tx<(Mapping & { reserved_bytes: string })[]>`
      SELECT namespace,connected,server_url,reserved_bytes::text FROM code.databases WHERE code_id=${input.claims.codeId}`;
    // Commit new intent before provisioning. An unchanged reservation must not lock the mapping:
    // the provisioner holds it during remote creation, and concurrent calls must reach the nonblocking lifecycle guard.
    if (!mapping) {
      await tx`INSERT INTO code.databases(code_id,namespace,server_url,reserved_bytes) VALUES(${input.claims.codeId},${namespace},${config.url},${capacity})
        ON CONFLICT(code_id) DO NOTHING`;
      [mapping] = await tx<(Mapping & { reserved_bytes: string })[]>`
        SELECT namespace,connected,server_url,reserved_bytes::text FROM code.databases WHERE code_id=${input.claims.codeId}`;
    } else if (capacity > Number(mapping.reserved_bytes)) {
      await tx`UPDATE code.databases SET reserved_bytes=${capacity}
        WHERE code_id=${input.claims.codeId} AND reserved_bytes<${capacity}`;
    }
    if (!mapping) throw new CodeBridgeRefusal("code_db_unavailable", 503);
    sameServer(mapping, config.url);
    const wallMs = await codeSettings.get("core.code.wall_clock_ms");
    const [run] = await tx<{ remaining_ms: number }[]>`SELECT GREATEST(1, EXTRACT(EPOCH FROM
      (started_at + ${wallMs} * interval '1 millisecond' - clock_timestamp())) * 1000)::double precision AS remaining_ms
      FROM code.runs WHERE id=${input.claims.runId}::uuid`;
    return {
      namespace: mapping.namespace,
      connected: mapping.connected,
      remainingMs: run?.remaining_ms ?? 1,
      bytes: Math.min(bytes, capacity),
    };
  });
  const deadlineMs = Math.max(
    1,
    Math.floor(Math.min(CODE_DATABASE_LIMITS.statementMs, prepared.remainingMs, input.claims.exp * 1000 - Date.now())),
  );
  const client = factory(config, AbortSignal.any([input.signal, AbortSignal.timeout(deadlineMs)]));
  const mappedNamespace = prepared.namespace;
  if (!prepared.connected) {
    await sql.begin(async (tx) => {
      await lockNamespaceChange(tx);
      // The committed intent and namespace lifecycle lock fence deletion. Do not lock the Code:
      // request admission takes that row while holding the global dispatch lock.
      const [code] = await tx<{ state: string }[]>`SELECT state FROM code.codes WHERE id=${input.claims.codeId}`;
      if (code?.state !== "active") throw new CodeBridgeRefusal("code_not_active");
      const [mapping] = await tx<
        Mapping[]
      >`SELECT namespace,connected,server_url FROM code.databases WHERE code_id=${input.claims.codeId} FOR UPDATE`;
      if (!mapping || mapping.namespace !== mappedNamespace) throw new CodeBridgeRefusal("code_db_unavailable", 503);
      sameServer(mapping, config.url);
      if (!mapping.connected) {
        await client.create(mappedNamespace, prepared.bytes, CODE_DATABASE_LIMITS.statementMs);
        await tx`UPDATE code.databases SET connected=TRUE WHERE code_id=${input.claims.codeId}`;
      }
    });
  }
  // Fixed server timeout avoids concurrent runs changing one another's statement budget.
  // Apply the current quota before issuance; remaining run time is enforced by the request signal.
  await client.configure(mappedNamespace, prepared.bytes, CODE_DATABASE_LIMITS.statementMs);
  await sql.begin((tx) => authorizeCodeCall(call, tx));
  const data = await client.execute(mappedNamespace, input.request);
  // Telemetry must not turn an already committed RSQL write into a retryable failure.
  await sql`UPDATE code.databases SET last_access_at=clock_timestamp() WHERE code_id=${input.claims.codeId} AND namespace=${mappedNamespace}`.catch(
    () => {},
  );
  if (Buffer.byteLength(JSON.stringify(data)) > CODE_DATABASE_LIMITS.resultBytes) throw new CodeBridgeRefusal("code_db_limit");
  return Response.json({ ok: true, data });
}

/** One nonblocking namespace lifecycle operation fleet-wide bounds the only remote work protected by a SQL transaction. */
export async function lockNamespaceChange(tx: SQL) {
  const [lock] = await tx<
    { acquired: boolean }[]
  >`SELECT pg_try_advisory_xact_lock(hashtextextended('core.code.database-lifecycle',0)) AS acquired`;
  if (!lock?.acquired) throw new CodeBridgeRefusal("code_db_busy", 503);
}

/** Called while deleting the locked Code. Failure retains the existing durable cleanup job and mapping for retry. */
export async function deleteCodeDatabase(codeId: string, tx: SQL, factory: typeof createCodeDatabaseClient = createCodeDatabaseClient) {
  // Codes without a database do not need the remote lifecycle guard.
  const existing = await tx`SELECT code_id FROM code.databases WHERE code_id=${codeId}`;
  if (!existing.length) return;
  // Never wait on a creator's mapping row while deletion holds the Code row.
  await lockNamespaceChange(tx);
  const [mapping] = await tx<Mapping[]>`SELECT namespace,connected,server_url FROM code.databases WHERE code_id=${codeId} FOR UPDATE`;
  if (!mapping) return;
  const config = await readCodeDatabaseConfig();
  sameServer(mapping, config.url);
  await factory(config).remove(mapping.namespace);
}

export type CodeDatabaseUsage = {
  bytes: number | null;
  limit: number;
  state: "unused" | "ready" | "unavailable";
  owner?: { reserved: number; limit: number };
  canExport?: boolean;
  unused?: { since: string; deleteAt: string | null; namespace: string; canDelete?: boolean };
};
/** Reading usage never creates a database; remote failure leaves the Code page usable. */
export async function readCodeDatabaseUsage(
  codeId: string,
  factory: typeof createCodeDatabaseClient = createCodeDatabaseClient,
  signal?: AbortSignal,
): Promise<CodeDatabaseUsage> {
  const limit = await codeSettings.get("core.code.database_bytes");
  const owner = { reserved: await codeDatabaseOwnerCapacity(sql, codeId), limit: await codeSettings.get("core.code.database_owner_bytes") };
  const [mapping] = await sql<
    (Mapping & { unused_since: Date | null })[]
  >`SELECT namespace,connected,server_url,unused_since FROM code.databases WHERE code_id=${codeId}`;
  if (!mapping) return { bytes: 0, limit, state: "unused", owner };
  // Retention metadata must not take an active Code's page down. The sweep fails closed
  // on the same unreadable setting; omitting an unavailable date never authorizes deletion.
  const unused = mapping.unused_since ? await readDatabaseDeadline(codeId).catch(() => undefined) : undefined;
  try {
    const config = await readCodeDatabaseConfig();
    sameServer(mapping, config.url);
    const deadline = AbortSignal.timeout(2000); // Keep the interactive Code read usable during an RSQL outage.
    const usageSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const bytes = await factory(config, usageSignal).size(mapping.namespace);
    await sql`UPDATE code.databases SET last_size_bytes=${bytes} WHERE code_id=${codeId} AND namespace=${mapping.namespace}`;
    return { bytes, limit, state: "ready", owner, ...(unused ? { unused } : {}) };
  } catch {
    return { bytes: null, limit, state: "unavailable", owner, ...(unused ? { unused } : {}) };
  }
}

export async function readCodeDetails(codeId: string, context: CodeContext) {
  const result = await readCode(codeId, context);
  const database = await readCodeDatabaseUsage(codeId, createCodeDatabaseClient, context.signal);
  // Export follows the same service guard on both surfaces; Core admins can export without an editor share.
  database.canExport = result.permission === "editor" || codePerson(context).roles.includes("admin");
  if (database.unused)
    database.unused.canDelete =
      result.permission === "editor" || (codePerson(context).roles.includes("admin") && canRepairAppAccess(context.authority));
  if (!database.canExport) {
    delete database.owner;
    delete database.unused;
  }
  return { ...result, code: { ...result.code, database } };
}
