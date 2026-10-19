import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { toPgTextArray } from "@k2b/cloud/services";
import { normalizeNetworkHostname, parseNetworkAllowlist } from "@k2b/cloud/shared";
import { sql } from "bun";
import { z } from "zod";
import type { AdminBasesPage, AdminErrorCode, InternalTarget, InternalTargetsPage, OrphanDatabasesPage } from "../store/admin-contracts";
import { LimitsUpdateSchema } from "../store/admin-schemas";
import { assertStoreName } from "../store/base-schema";
import { baseStoreStatus, insertBaseStore } from "../store/base-status";
import { BaseOperationSuperseded, baseStore } from "../store/base-store";
import { verifyBaseCheckpoint } from "../store/maintenance";
import { requireStoreAdmin, type StoreIdentity } from "../store/service";
import { type AccessScope, requireBaseAccess } from "./access-control";
import { submitBaseLifecycleJob } from "./base-lifecycle";
import { readBasePolicy } from "./base-policy";
import { iso } from "./telemetry-values";

export class BaseAdminError extends Error {
  constructor(
    readonly code: AdminErrorCode,
    readonly status: 400 | 403 | 404 | 409 | 503 = 400,
  ) {
    super(code);
  }
}
const publicBase = async (id: string) => {
  if (!/^[0-9A-Za-z]{6}$/.test(id)) throw new BaseAdminError("INVALID_INPUT");
  const [row] = await sql<{ id: string; short_id: string }[]>`SELECT id,short_id FROM pulse.bases WHERE short_id=${id}`;
  if (!row) throw new BaseAdminError("NOT_FOUND", 404);
  return row;
};
export const retryBase = async (baseId: string, scope: AccessScope): Promise<Result<void>> => {
  const access = await requireBaseAccess(baseId, scope, "admin");
  if (!access.ok) return access;
  return retryInternal(baseId, scope);
};
const retryInternal = async (baseId: string, scope?: AccessScope): Promise<Result<void>> => {
  const policy = await readBasePolicy();
  const result = await sql.begin(async (tx) => {
    const [base] = await tx<{ short_id: string }[]>`SELECT short_id FROM pulse.bases WHERE id=${baseId}::uuid FOR UPDATE`;
    if (!base) return fail(err.notFound("Pulse base"));
    if (scope) {
      const access = await requireBaseAccess(baseId, scope, "admin", tx);
      if (!access.ok) return access;
    }
    const [existing] = await tx`SELECT state FROM pulse.base_stores WHERE base_id=${baseId}::uuid`;
    if (existing && existing.state !== "failed") return fail(err.conflict("Pulse base has no failed operation"));
    await insertBaseStore(baseId, policy, tx);
    await tx`UPDATE pulse.base_stores SET state=CASE operation WHEN 'delete' THEN 'deleting' WHEN 'clear' THEN 'clearing' ELSE 'provisioning' END,attempts=0,last_error=NULL,last_error_at=NULL,updated_at=now() WHERE base_id=${baseId}::uuid`;
    return ok(base.short_id);
  });
  if (!result.ok) return result;
  await submitBaseLifecycleJob(baseId, result.data);
  return ok();
};
const paging = (limit = 50, offset = 0) => ({
  limit: z.number().int().min(1).max(100).parse(limit),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(offset),
});
const adminBaseRow = async (baseId: string, now = new Date()) => {
  const [base] = await sql<
    {
      short_id: string;
      name: string;
      retention_days: number;
      rollup_retention_days: number;
      sensitive_retention_hours: number;
      created_at: Date;
      rollup_lag: boolean;
    }[]
  >`SELECT b.*,EXISTS(SELECT 1 FROM pulse.metric_hours h WHERE h.base_id=b.id AND (
    (h.state='dirty' AND h.hour<${now}::timestamptz-interval '3 hours') OR
    (h.state<>'sealed' AND date_trunc('day',h.hour,'UTC')+interval '1 day'<${now}::timestamptz-(b.retention_days+1)*interval '1 day')
  )) AS rollup_lag FROM pulse.bases b WHERE b.id=${baseId}::uuid`;
  if (!base) throw new BaseAdminError("NOT_FOUND", 404);
  const names = await sql<
    { name: string; count: number }[]
  >`SELECT count(*) OVER()::int AS count,COALESCE(u.display_name,sa.name,g.name,'Member') AS name FROM pulse.base_access ba JOIN auth.access a ON a.id=ba.access_id LEFT JOIN auth.users u ON u.id=a.user_id LEFT JOIN auth.service_accounts sa ON sa.id=a.service_account_id LEFT JOIN auth.groups g ON g.id=a.group_id WHERE ba.base_id=${baseId}::uuid AND a.permission='admin' ORDER BY a.created_at LIMIT 3`;
  return {
    rollupLag: base.rollup_lag,
    id: base.short_id,
    name: base.name,
    admins: names.slice(0, 3).map((n) => n.name),
    adminCount: names[0]?.count ?? 0,
    rawRetentionDays: base.retention_days,
    rollupRetentionDays: base.rollup_retention_days,
    sensitiveRetentionHours: base.sensitive_retention_hours,
    createdAt: iso(base.created_at),
    store: await baseStoreStatus(baseId),
  };
};
export const listAdminBases = async (
  identity: StoreIdentity,
  params: { limit?: number; offset?: number; q?: string } = {},
  clock = () => new Date(),
): Promise<AdminBasesPage> => {
  requireStoreAdmin(identity);
  const { limit, offset } = paging(params.limit, params.offset);
  const query = params.q?.trim() || null;
  if (query && query.length > 500) throw new BaseAdminError("INVALID_INPUT");
  const pattern = query ? `%${query.replace(/([\\%_])/g, "\\$1")}%` : null;
  const rows = await sql<
    { id: string }[]
  >`SELECT id FROM pulse.bases WHERE (${pattern}::text IS NULL OR name ILIKE ${pattern} ESCAPE '\\' OR short_id=${query}) ORDER BY (short_id=${query}) DESC,created_at,id LIMIT ${limit} OFFSET ${offset}`;
  const [count] = await sql<
    { count: number }[]
  >`SELECT count(*)::int AS count FROM pulse.bases WHERE (${pattern}::text IS NULL OR name ILIKE ${pattern} ESCAPE '\\' OR short_id=${query})`;
  const [disk] = await sql<
    { free_bytes: string | null; total_bytes: string | null; measured_at: Date | null }[]
  >`SELECT * FROM pulse.store_instance`;
  const [used] = await sql<
    { bytes: string }[]
  >`SELECT COALESCE(sum(s.usage_bytes),0)::text AS bytes FROM pulse.base_stores s JOIN pulse.bases b ON b.id=s.base_id`;
  const total = count?.count ?? 0;
  return {
    items: await Promise.all(rows.map((r) => adminBaseRow(r.id, clock()))),
    total,
    nextOffset: offset + rows.length < total ? offset + rows.length : null,
    usedBytes: Number(used?.bytes ?? 0),
    disk: disk?.measured_at
      ? { freeBytes: Number(disk.free_bytes), totalBytes: Number(disk.total_bytes), measuredAt: iso(disk.measured_at) }
      : null,
  };
};
export const updateBaseLimits = async (identity: StoreIdentity, id: string, input: unknown) => {
  requireStoreAdmin(identity);
  const base = await publicBase(id),
    parsed = LimitsUpdateSchema.safeParse(input);
  if (!parsed.success) throw new BaseAdminError("INVALID_INPUT");
  const v = parsed.data,
    l = v.limits;
  const updated = await sql.begin(async (tx) => {
    await tx`SELECT id FROM pulse.bases WHERE id=${base.id}::uuid FOR UPDATE`;
    return tx`UPDATE pulse.base_stores SET profile=COALESCE(${v.profile ?? null},profile),values_per_minute=COALESCE(${l?.valuesPerMinute ?? null},values_per_minute),bytes_per_minute=COALESCE(${l?.bytesPerMinute ?? null},bytes_per_minute),storage_bytes=COALESCE(${l?.storageBytes ?? null},storage_bytes),max_series=COALESCE(${l?.maxSeries ?? null},max_series),max_event_kinds=COALESCE(${l?.maxEventKinds ?? null},max_event_kinds),max_state_keys=COALESCE(${l?.maxStateKeys ?? null},max_state_keys),reconcile_needed=true,updated_at=now() WHERE base_id=${base.id}::uuid RETURNING base_id`;
  });
  if (!updated.length) throw new BaseAdminError("BASE_BUSY", 409);
  await submitBaseLifecycleJob(base.id, base.short_id);
  return adminBaseRow(base.id);
};
export const adminBaseAction = async (identity: StoreIdentity, id: string, action: "retry" | "recheck" | "recreate") => {
  requireStoreAdmin(identity);
  const base = await publicBase(id);
  if (action === "retry") {
    const result = await retryInternal(base.id);
    if (!result.ok) throw new BaseAdminError("BASE_BUSY", 409);
  } else if (action === "recheck") {
    try {
      await verifyBaseCheckpoint(base.id, baseStore, true);
    } catch (error) {
      if (error instanceof BaseOperationSuperseded) throw new BaseAdminError("BASE_BUSY", 409);
      throw new BaseAdminError("STORE_UNAVAILABLE", 503);
    }
  } else {
    const changed = await sql.begin(async (tx) => {
      await tx`SELECT id FROM pulse.bases WHERE id=${base.id}::uuid FOR UPDATE`;
      return tx`UPDATE pulse.base_stores SET reset_generation=reset_generation+1,state='clearing',operation='clear',schema_version=0,pending_checkpoint_id=NULL,attempts=0,updated_at=now() WHERE base_id=${base.id}::uuid AND state='active' RETURNING base_id`;
    });
    if (!changed.length) throw new BaseAdminError("BASE_BUSY", 409);
    await submitBaseLifecycleJob(base.id, base.short_id);
  }
  return adminBaseRow(base.id);
};
export const normalizeInternalTarget = (entry: string) => {
  if (/\/0$/.test(entry)) throw new BaseAdminError("TARGET_TOO_BROAD");
  if (entry.length > 300) throw new BaseAdminError("INVALID_TARGET");
  let parsed: ReturnType<typeof parseNetworkAllowlist>;
  try {
    parsed = parseNetworkAllowlist([entry]);
  } catch {
    throw new BaseAdminError("INVALID_TARGET");
  }
  const restricted = [...(parsed.hostPorts ?? [])][0];
  if (restricted) {
    const port = [...restricted[1]][0]!;
    return { entry: `${restricted[0].includes(":") ? `[${restricted[0]}]` : restricted[0]}:${port}`, scope: "host_port" as const, port };
  }
  const host = [...parsed.hosts][0];
  if (host) return { entry: normalizeNetworkHostname(host), scope: "host" as const, port: null };
  const network = parsed.networks[0];
  if (!network) throw new BaseAdminError("INVALID_TARGET");
  return {
    entry: entry.includes("/") ? `${network.address}/${network.bits}` : network.address,
    scope: entry.includes("/") ? ("network" as const) : ("host" as const),
    port: null,
  };
};
const targetRow = (row: { id: string; short_id: string; name: string; entry: string; created_at: Date }): InternalTarget => ({
  id: row.id,
  baseId: row.short_id,
  baseName: row.name,
  ...normalizeInternalTarget(row.entry),
  createdAt: iso(row.created_at),
});
export const listInternalTargets = async (
  identity: StoreIdentity,
  params: { limit?: number; offset?: number; baseId?: string } = {},
): Promise<InternalTargetsPage> => {
  requireStoreAdmin(identity);
  const { limit, offset } = paging(params.limit, params.offset);
  const baseId = params.baseId ? (await publicBase(params.baseId)).id : null;
  const rows = await sql<
    { id: string; short_id: string; name: string; entry: string; created_at: Date }[]
  >`SELECT t.*,b.short_id,b.name FROM pulse.base_internal_targets t JOIN pulse.bases b ON b.id=t.base_id WHERE (${baseId}::uuid IS NULL OR t.base_id=${baseId}::uuid) ORDER BY t.created_at,t.id LIMIT ${limit} OFFSET ${offset}`;
  const [count] = await sql<
    { count: number }[]
  >`SELECT count(*)::int AS count FROM pulse.base_internal_targets WHERE (${baseId}::uuid IS NULL OR base_id=${baseId}::uuid)`;
  const total = count?.count ?? 0;
  return { items: rows.map(targetRow), total, nextOffset: offset + rows.length < total ? offset + rows.length : null };
};
export const addInternalTarget = async (identity: StoreIdentity, input: { baseId: string; entry: string }) => {
  requireStoreAdmin(identity);
  const base = await publicBase(input.baseId),
    normalized = normalizeInternalTarget(input.entry);
  const [row] = await sql<
    { id: string; entry: string; created_at: Date }[]
  >`INSERT INTO pulse.base_internal_targets(base_id,entry,created_by) VALUES(${base.id}::uuid,${normalized.entry},${identity.accessSubject.type === "user" ? identity.accessSubject.userId : null}::uuid) ON CONFLICT(base_id,entry) DO NOTHING RETURNING *`;
  if (!row) throw new BaseAdminError("TARGET_EXISTS", 409);
  const [b] = await sql<{ name: string }[]>`SELECT name FROM pulse.bases WHERE id=${base.id}::uuid`;
  return targetRow({ ...row, short_id: base.short_id, name: b?.name ?? "" });
};
export const removeInternalTarget = async (identity: StoreIdentity, id: string) => {
  requireStoreAdmin(identity);
  if (!z.uuid().safeParse(id).success) throw new BaseAdminError("INVALID_INPUT");
  const result = await sql`DELETE FROM pulse.base_internal_targets WHERE id=${id}::uuid`;
  if (!result.count) throw new BaseAdminError("NOT_FOUND", 404);
  return { ok: true as const };
};
const reservedDatabases = async (candidates: string[], prefix: string): Promise<string[]> => {
  const baseIds = candidates.map((name) => databaseBaseId(name, prefix));
  const references = await sql<
    { database_name: string }[]
  >`SELECT database_name FROM pulse.base_stores WHERE database_name=ANY(${toPgTextArray(candidates)}::text[])
    UNION ALL SELECT ${prefix} || replace(id::text,'-','') AS database_name FROM pulse.bases WHERE id=ANY(${toPgTextArray(baseIds)}::uuid[])`;
  return references.map((row) => row.database_name);
};
const databaseBaseId = (database: string, prefix: string) => {
  const hex = database.slice(prefix.length);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export const listOrphans = async (
  identity: StoreIdentity,
  params: { limit?: number; after?: string } = {},
  store = baseStore,
  findReserved = reservedDatabases,
): Promise<OrphanDatabasesPage> => {
  requireStoreAdmin(identity);
  const { limit } = paging(params.limit);
  let after = params.after ?? "";
  if (after) {
    try {
      assertStoreName(after, store.prefix);
    } catch {
      throw new BaseAdminError("INVALID_INPUT");
    }
  }
  const items: OrphanDatabasesPage["items"] = [];
  // Bound both ClickHouse and Postgres work even when every database is reserved.
  const batchSize = 500;
  for (let batch = 0; batch < 4; batch++) {
    const rows = await store.query(
      "SELECT name FROM system.databases WHERE match(name,{pattern:String}) AND name > {after:String} ORDER BY name LIMIT 500",
      { pattern: `^${store.prefix}[0-9a-f]{32}$`, after },
    );
    const candidates = rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : []));
    const reserved = new Set(await findReserved(candidates, store.prefix));
    for (const [index, database] of candidates.entries()) {
      after = database;
      if (!reserved.has(database)) items.push({ database });
      if (items.length === limit) return { items, nextCursor: index < candidates.length - 1 || rows.length === batchSize ? after : null };
    }
    if (rows.length < batchSize) return { items, nextCursor: null };
  }
  return { items, nextCursor: after };
};
export const deleteOrphan = async (identity: StoreIdentity, database: string, store = baseStore) => {
  requireStoreAdmin(identity);
  let quoted: string;
  try {
    quoted = assertStoreName(database, store.prefix);
  } catch {
    throw new BaseAdminError("INVALID_INPUT");
  }
  const hex = database.slice(store.prefix.length),
    baseId = databaseBaseId(database, store.prefix);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('pulse.base.creation',0))`;
    const [used] =
      await tx`SELECT base_id FROM pulse.base_stores WHERE database_name=${database} UNION ALL SELECT id FROM pulse.bases WHERE id=${baseId}::uuid`;
    if (used) throw new BaseAdminError("ORPHAN_IN_USE", 409);
    await store.query(`DROP USER IF EXISTS ${assertStoreName(`${store.prefix}r_${hex}`, store.prefix, true)}`);
    await store.query(`DROP DATABASE IF EXISTS ${quoted} SYNC`);
    return { ok: true as const };
  });
};
