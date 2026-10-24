import { createHash, randomBytes } from "node:crypto";
import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { decryptSecret, encryptSecret, isUniqueViolation } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import {
  type Dashboard,
  type DashboardDefinition,
  DashboardDefinitionSchema,
  DashboardSaveSchema,
  dashboardExposure,
} from "../dashboard-contracts";
import { withShortId } from "../lib/short-id";
import { accessScopeFor, requireBaseAccess, requireBaseActive } from "./access-control";
import { recordBaseActivity } from "./base-activity";
import { resolvePublicId } from "./public-resources";
import type { SqlIdentity } from "./sql-service";
import { iso } from "./telemetry-values";

export type DashboardIdentity = SqlIdentity & { baseId: string; requestId?: string };
type Input = DashboardIdentity & { dashboardId: string };
export type DashboardRow = {
  id: string;
  short_id: string;
  base_id: string;
  base_short_id: string;
  name: string;
  definition: DashboardDefinition;
  revision: number;
  public_token_hash: string | null;
  public_exposure: string | null;
  created_at: Date;
  updated_at: Date;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const dashboardTokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
const map = (row: DashboardRow): Dashboard => ({
  id: row.short_id,
  baseId: row.base_short_id,
  name: row.name,
  definition: DashboardDefinitionSchema.parse(row.definition),
  revision: row.revision,
  published: !!row.public_token_hash,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});
export const authorizeDashboardBase = async (input: DashboardIdentity, permission: "read" | "write") => {
  const scope = accessScopeFor(input.actor, input.accessSubject);
  if (!scope.ok) return scope;
  const baseId = z.uuid().safeParse(input.baseId).success ? input.baseId : await resolvePublicId("bases", input.baseId);
  if (!baseId) return fail(err.notFound("Pulse base"));
  const access = await requireBaseAccess(baseId, scope.data, permission);
  return access.ok ? ok({ baseId, scope: scope.data }) : access;
};
export const findDashboard = async (baseId: string, reference: string, db: typeof sql = sql): Promise<DashboardRow | undefined> => {
  const condition = z.uuid().safeParse(reference).success ? sql`d.id=${reference}::uuid` : sql`d.short_id=${reference}`;
  const [row] = await db<DashboardRow[]>`SELECT d.*,b.short_id AS base_short_id FROM pulse.dashboards d JOIN pulse.bases b ON b.id=d.base_id
    WHERE d.base_id=${baseId}::uuid AND ${condition} AND b.deletion_started_at IS NULL`;
  return row;
};
const list = async (input: DashboardIdentity & { limit?: number; offset?: number }) => {
  const access = await authorizeDashboardBase(input, "read");
  if (!access.ok) return access;
  const paging = z
    .object({ limit: z.number().int().min(1).max(1000), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
    .safeParse({ limit: input.limit ?? 20, offset: input.offset ?? 0 });
  if (!paging.success) return fail(err.badInput("Invalid page size or offset"));
  const { limit, offset } = paging.data;
  const rows = await sql<DashboardRow[]>`SELECT d.*,b.short_id AS base_short_id FROM pulse.dashboards d JOIN pulse.bases b ON b.id=d.base_id
    WHERE d.base_id=${access.data.baseId}::uuid AND b.deletion_started_at IS NULL ORDER BY d.updated_at DESC,d.id LIMIT ${limit} OFFSET ${offset}`;
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pulse.dashboards WHERE base_id=${access.data.baseId}::uuid`;
  const total = count?.n ?? 0;
  return ok({ items: rows.map(map), total, nextOffset: offset + rows.length < total ? offset + rows.length : null });
};
const get = async (input: Input): Promise<Result<Dashboard>> => {
  const access = await authorizeDashboardBase(input, "read");
  if (!access.ok) return access;
  const row = await findDashboard(access.data.baseId, input.dashboardId);
  return row ? ok(map(row)) : fail(err.notFound("Dashboard"));
};
/** Canonical resource reader resolves its own base before the shared access check. */
export const readDashboardResource = async (input: SqlIdentity & { id: string }) => {
  const [row] = await sql<{ base_id: string }[]>`SELECT base_id FROM pulse.dashboards WHERE short_id=${input.id}`;
  return row ? get({ ...input, baseId: row.base_id, dashboardId: input.id }) : fail(err.notFound("Dashboard"));
};
const operation = async <T>(
  input: DashboardIdentity & { idempotencyKey?: string },
  kind: string,
  payload: unknown,
  change: (db: typeof sql, baseId: string) => Promise<Result<T>>,
): Promise<Result<T>> => {
  const access = await authorizeDashboardBase(input, "write");
  if (!access.ok) return access;
  if (input.idempotencyKey !== undefined && (!input.idempotencyKey.trim() || Buffer.byteLength(input.idempotencyKey) > 200))
    return fail(err.badInput("Idempotency-Key must contain 1 to 200 bytes"));
  const actor = input.actor.kind === "user" ? input.actor.user.id : input.actor.serviceAccount.id;
  const key = input.idempotencyKey === undefined ? null : hash([kind, input.actor.kind, actor, input.accessSubject, input.idempotencyKey]);
  const digest = hash(payload),
    { baseId, scope } = access.data;
  return sql.begin(async (tx): Promise<Result<T>> => {
    await tx`SELECT id FROM pulse.bases WHERE id=${baseId}::uuid FOR UPDATE`;
    const current = await requireBaseAccess(baseId, scope, "write", tx);
    if (!current.ok) return current;
    await tx`WITH expired AS (SELECT operation_key FROM pulse.dashboard_operations WHERE base_id=${baseId}::uuid AND expires_at<=now() LIMIT 1000)
      DELETE FROM pulse.dashboard_operations op USING expired WHERE op.base_id=${baseId}::uuid AND op.operation_key=expired.operation_key`;
    if (key) {
      const [receipt] = await tx<{ input_hash: string; response: string }[]>`SELECT input_hash,response FROM pulse.dashboard_operations
        WHERE base_id=${baseId}::uuid AND operation_key=${key} AND expires_at>now()`;
      if (receipt)
        return receipt.input_hash === digest
          ? ok(await decryptSecret<T>(receipt.response))
          : fail(err.conflict("Idempotency-Key was used for different input"));
    }
    const active = await requireBaseActive(baseId, tx);
    if (!active.ok) return active;
    const result = await change(tx, baseId);
    if (result.ok && key)
      await tx`INSERT INTO pulse.dashboard_operations(base_id,operation_key,input_hash,response)
      VALUES(${baseId}::uuid,${key},${digest},${await encryptSecret(result.data)})
      ON CONFLICT(base_id,operation_key) DO UPDATE SET input_hash=EXCLUDED.input_hash,response=EXCLUDED.response,expires_at=EXCLUDED.expires_at`;
    return result;
  });
};
const save = async (
  input: DashboardIdentity & {
    dashboardId?: string;
    name: string;
    definition: DashboardDefinition;
    expectedRevision?: number;
    idempotencyKey?: string;
  },
): Promise<Result<Dashboard>> => {
  const parsed = DashboardSaveSchema.safeParse({
    name: input.name,
    definition: input.definition,
    expectedRevision: input.expectedRevision,
  });
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid dashboard"));
  if (Boolean(input.dashboardId) !== (input.expectedRevision !== undefined))
    return fail(err.badInput("Use dashboardId and expectedRevision together"));
  const { name, definition } = parsed.data;
  try {
    return await withShortId("dashboard", (shortId) =>
      operation(input, "save", [input.dashboardId, parsed.data], async (tx, baseId) => {
        const before = input.dashboardId ? await findDashboard(baseId, input.dashboardId, tx) : undefined;
        if (input.dashboardId && !before) return fail(err.notFound("Dashboard"));
        if (before && before.revision !== input.expectedRevision)
          return fail(err.conflict("Dashboard changed. Read its revision and retry."));
        const revoke = !!before?.public_token_hash && before.public_exposure !== dashboardExposure(definition);
        let id: string;
        if (before) {
          id = before.id;
          await tx`UPDATE pulse.dashboards SET name=${name},definition=(${JSON.stringify(definition)}::jsonb #>> '{}')::jsonb,
          revision=revision+1,updated_at=now(),public_token_hash=CASE WHEN ${revoke} THEN NULL ELSE public_token_hash END,
          public_exposure=CASE WHEN ${revoke} THEN NULL ELSE public_exposure END WHERE id=${id}::uuid`;
        } else {
          const [created] = await tx<{ id: string }[]>`INSERT INTO pulse.dashboards(short_id,base_id,name,definition)
          VALUES(${shortId},${baseId}::uuid,${name},(${JSON.stringify(definition)}::jsonb #>> '{}')::jsonb) RETURNING id`;
          if (!created) return fail(err.internal("Could not save dashboard"));
          id = created.id;
        }
        const row = await findDashboard(baseId, id, tx);
        if (!row) return fail(err.internal("Could not read dashboard"));
        await recordBaseActivity(tx, {
          ...input,
          baseId,
          kind: "dashboard_saved",
          data: { dashboardId: row.short_id, name, publicationEnded: revoke },
        });
        return ok(map(row));
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error, "idx_pulse_dashboards_name")) return fail(err.conflict("A dashboard with this name already exists"));
    throw error;
  }
};
const publish = async (input: Input & { expectedRevision: number; columns: Record<string, string[]>; idempotencyKey?: string }) => {
  // A token is returned only by this explicit operation; listing never reveals it.
  return operation(input, "publish", [input.dashboardId, input.expectedRevision, input.columns], async (tx, baseId) => {
    const row = await findDashboard(baseId, input.dashboardId, tx);
    if (!row) return fail(err.notFound("Dashboard"));
    if (row.revision !== input.expectedRevision) return fail(err.conflict("Dashboard changed. Review its columns again."));
    const panels = DashboardDefinitionSchema.parse(row.definition).panels;
    if (
      !panels.length ||
      Object.keys(input.columns).length !== panels.length ||
      panels.some((panel) => JSON.stringify(input.columns[panel.id]) !== JSON.stringify(panel.columns))
    )
      return fail(err.badInput("Confirm the exact output columns for every panel"));
    const token = randomBytes(32).toString("base64url");
    await tx`UPDATE pulse.dashboards SET public_token_hash=${dashboardTokenHash(token)},public_exposure=${dashboardExposure(row.definition)},
      revision=revision+1,updated_at=now() WHERE id=${row.id}::uuid`;
    await recordBaseActivity(tx, { ...input, baseId, kind: "dashboard_published", data: { dashboardId: row.short_id, name: row.name } });
    return ok({ href: `/app/pulse/public/${token}`, revision: row.revision + 1 });
  });
};
const remove = async (input: Input & { expectedRevision: number; idempotencyKey?: string; unpublish?: boolean }) =>
  operation(input, input.unpublish ? "unpublish" : "delete", [input.dashboardId, input.expectedRevision], async (tx, baseId) => {
    const row = await findDashboard(baseId, input.dashboardId, tx);
    if (!row) return fail(err.notFound("Dashboard"));
    if (row.revision !== input.expectedRevision) return fail(err.conflict("Dashboard changed. Read its revision and retry."));
    if (input.unpublish)
      await tx`UPDATE pulse.dashboards SET public_token_hash=NULL,public_exposure=NULL,revision=revision+1,updated_at=now() WHERE id=${row.id}::uuid`;
    else await tx`DELETE FROM pulse.dashboards WHERE id=${row.id}::uuid`;
    await recordBaseActivity(tx, {
      ...input,
      baseId,
      kind: input.unpublish ? "dashboard_unpublished" : "dashboard_deleted",
      data: { dashboardId: row.short_id, name: row.name },
    });
    return ok({ deleted: !input.unpublish, revision: row.revision + 1 });
  });
export const dashboards = { list, get, save, publish, remove };
