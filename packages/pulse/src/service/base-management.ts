import {
  type AccessEntry,
  ensureManagerRemains,
  err,
  fail,
  ok,
  type PermissionLevel,
  type Principal,
  type Result,
  resolveDisplayNames,
} from "@k2b/cloud/server";
import { type ServiceAccountKind, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type { PulseBase } from "../contracts";
import { withShortId } from "../lib/short-id";
import { baseStoreStatus, insertBaseStore } from "../store/base-status";
import type { baseStore } from "../store/base-store";
import { RetentionStoreUnavailable, retentionPreview } from "../store/retention";
import {
  type AccessScope,
  listBaseIdsVisibleTo,
  PULSE_BASE_RESOURCE_TYPE,
  requireBaseAccess,
  requireBaseActive,
  userIdForScope,
} from "./access-control";
import { submitBaseLifecycleJob } from "./base-lifecycle";
import { readBasePolicy } from "./base-policy";
import { PULSE_APP_ID, PULSE_SOURCE_RESOURCE_TYPE } from "./source-management";
import { iso, isoNullable } from "./telemetry-values";

type BaseRow = {
  id: string;
  short_id: string;
  name: string;
  description: string | null;
  retention_days: number;
  rollup_retention_days: number;
  sensitive_retention_hours: number;
  created_by: string | null;
  deletion_started_at: Date | string | null;
  deletion_failed_at: Date | string | null;
  deletion_error: string | null;
  data_clear_started_at: Date | string | null;
  data_clear_completed_at: Date | string | null;
  data_clear_failed_at: Date | string | null;
  data_clear_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type AccessRow = {
  id: string;
  user_id: string | null;
  group_id: string | null;
  service_account_id: string | null;
  authenticated_only: boolean;
  permission: PermissionLevel;
  created_at: Date | string;
};

type BaseUpdateInput = {
  name?: string;
  description?: string | null;
  rawRetentionDays?: number;
  rollupRetentionDays?: number;
  sensitiveRetentionHours?: number;
};

type BaseUpdateValues = {
  name: string;
  description: string | null;
  rawRetentionDays: number;
  rollupRetentionDays: number;
  sensitiveRetentionHours: number;
};

const mapBase = async (row: BaseRow): Promise<PulseBase> => ({
  store: await baseStoreStatus(row.id),
  id: row.id,
  name: row.name,
  description: row.description,
  rawRetentionDays: row.retention_days,
  rollupRetentionDays: row.rollup_retention_days,
  sensitiveRetentionHours: row.sensitive_retention_hours,
  createdBy: row.created_by,
  deletionStartedAt: isoNullable(row.deletion_started_at),
  deletionFailedAt: isoNullable(row.deletion_failed_at),
  deletionError: row.deletion_error,
  dataClearStartedAt: isoNullable(row.data_clear_started_at),
  dataClearCompletedAt: isoNullable(row.data_clear_completed_at),
  dataClearFailedAt: isoNullable(row.data_clear_failed_at),
  dataClearError: row.data_clear_error,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const principalFromAccessRow = (row: Pick<AccessRow, "user_id" | "group_id" | "service_account_id" | "authenticated_only">): Principal => {
  if (row.user_id) return { type: "user", userId: row.user_id };
  if (row.group_id) return { type: "group", groupId: row.group_id };
  if (row.service_account_id) return { type: "service_account", serviceAccountId: row.service_account_id };
  if (row.authenticated_only) return { type: "authenticated" };
  return { type: "public" };
};

const mapAccessRow = (row: AccessRow): AccessEntry => ({
  id: row.id,
  principal: principalFromAccessRow(row),
  permission: row.permission,
  createdAt: iso(row.created_at),
});

const deleteBoundServiceAccounts = async (baseId: string, db: typeof sql = sql): Promise<void> => {
  await db`
    DELETE FROM auth.service_accounts
    WHERE kind = 'resource_bound'
      AND app_id = ${PULSE_APP_ID}
      AND (
        (
          resource_type = ${PULSE_BASE_RESOURCE_TYPE}
          AND resource_id = (SELECT short_id FROM pulse.bases WHERE id = ${baseId}::uuid)
        )
        OR (
          resource_type = ${PULSE_SOURCE_RESOURCE_TYPE}
          AND resource_id IN (
            SELECT short_id
            FROM pulse.sources
            WHERE base_id = ${baseId}::uuid
          )
        )
      )
  `;
};

export const listBases = async (
  user: AccessScope,
  params: { query?: string | null; limit?: number; offset?: number } = {},
): Promise<Result<PulseBase[]>> => {
  const baseIds = await listBaseIdsVisibleTo(user, params);
  if (baseIds.length === 0) return ok([]);
  const rows = await sql<BaseRow[]>`
    SELECT b.*
    FROM pulse.bases b
    WHERE b.deletion_started_at IS NULL
      AND b.id = ANY(${toPgUuidArray(baseIds)}::uuid[])
    ORDER BY b.updated_at DESC, b.name ASC, b.id ASC
  `;
  return ok(await Promise.all(rows.map(mapBase)));
};

/** Bases the scope administers whose deletion still runs or failed; the overview keeps them until the deletion finishes. */
export const listDeletingBases = async (user: AccessScope): Promise<Result<PulseBase[]>> => {
  const baseIds = await listBaseIdsVisibleTo(user, { deleting: true, limit: 100 });
  if (baseIds.length === 0) return ok([]);
  const rows = await sql<BaseRow[]>`
    SELECT b.*
    FROM pulse.bases b
    WHERE b.deletion_started_at IS NOT NULL
      AND b.id = ANY(${toPgUuidArray(baseIds)}::uuid[])
    ORDER BY b.updated_at DESC, b.name ASC, b.id ASC
  `;
  return ok(await Promise.all(rows.map(mapBase)));
};

export const createBase = async (params: {
  name: string;
  description?: string | null;
  user: AccessScope;
  isCloudAdmin?: boolean;
  agent: boolean;
}): Promise<Result<PulseBase>> => {
  const policy = await readBasePolicy();
  if (
    ("subject" in params.user &&
      (params.user.serviceAccount.kind === "resource_bound" || !params.user.scopes.some((s) => s === "write" || s === "admin"))) ||
    (policy.baseCreation === "people" && params.agent) ||
    (policy.baseCreation === "admins" && (params.agent || !params.isCloudAdmin))
  )
    return fail({
      code: "PULSE_BASE_CREATION_NOT_ALLOWED",
      status: 403,
      message: "Creating bases is restricted by policy. A Cloud admin can change this under Administration -> Pulse -> Bases.",
    });
  const creator = userIdForScope(params.user);
  const serviceAccountId = "subject" in params.user ? params.user.subject.serviceAccountId : null;
  const name = params.name.trim();
  if (!name) return fail(err.badInput("Base name is required"));

  const created = await withShortId("base", (shortId) =>
    sql.begin(async (tx): Promise<Result<BaseRow>> => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('pulse.base.creation',0))`;
      const [count] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM pulse.bases WHERE deletion_started_at IS NULL`;
      if ((count?.count ?? 0) >= policy.maxBases)
        return fail({
          code: "PULSE_BASE_LIMIT_REACHED",
          status: 409,
          message: "Base limit reached. A Cloud admin can raise the maximum under Administration -> Pulse -> Bases.",
        });
      const [base] = await tx<BaseRow[]>`
      INSERT INTO pulse.bases (short_id, name, description, created_by,retention_days)
      VALUES (${shortId}, ${name}, ${params.description?.trim() || null}, ${creator}::uuid,${Math.min(30, policy.maxRawRetentionDays)})
      RETURNING *
    `;
      if (!base) return fail(err.internal("Failed to create Pulse base"));

      const [access] = await tx<{ id: string }[]>`
      INSERT INTO auth.access (user_id, service_account_id, permission)
      VALUES (${creator}::uuid, ${serviceAccountId}::uuid, 'admin'::auth.permission_level)
      RETURNING id
    `;
      if (!access) return fail(err.internal("Failed to create base access"));
      await tx`
      INSERT INTO pulse.base_access (base_id, access_id)
      VALUES (${base.id}::uuid, ${access.id}::uuid)
    `;
      await insertBaseStore(base.id, policy, tx);
      return ok(base);
    }),
  );

  if (!created.ok) return created;
  await submitBaseLifecycleJob(created.data.id, created.data.short_id);
  return ok(await mapBase(created.data));
};

export const listBaseAccess = async (baseId: string, user: AccessScope): Promise<Result<AccessEntry[]>> => {
  const access = await requireBaseAccess(baseId, user, "admin");
  if (!access.ok) return fail(access.error);
  const rows = await sql<AccessRow[]>`
    SELECT a.id, a.user_id, a.group_id, a.service_account_id, a.authenticated_only, a.permission, a.created_at
    FROM pulse.base_access ba
    JOIN auth.access a ON a.id = ba.access_id
    WHERE ba.base_id = ${baseId}::uuid
    ORDER BY a.created_at
  `;
  return ok(await resolveDisplayNames(rows.map(mapAccessRow)));
};

export const grantBaseAccess = async (params: {
  baseId: string;
  user: AccessScope;
  principal: Principal;
  permission: Exclude<PermissionLevel, "none">;
}): Promise<Result<AccessEntry>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "admin");
  if (!access.ok) return fail(access.error);

  const created = await sql.begin(async (tx): Promise<Result<AccessRow>> => {
    const active = await requireBaseActive(params.baseId, tx);
    if (!active.ok) return active;
    const authorized = await requireBaseAccess(params.baseId, params.user, "admin", tx);
    if (!authorized.ok) return authorized;
    let userId: string | null = null;
    let groupId: string | null = null;
    let serviceAccountId: string | null = null;
    let authenticatedOnly = false;

    if (params.principal.type === "user") {
      userId = params.principal.userId;
      const [userRow] = await tx<{ id: string }[]>`SELECT id FROM auth.users WHERE id = ${userId}::uuid`;
      if (!userRow) return fail(err.notFound("User"));
    } else if (params.principal.type === "group") {
      groupId = params.principal.groupId;
      const [groupRow] = await tx<{ id: string }[]>`SELECT id FROM auth.groups WHERE id = ${groupId}::uuid`;
      if (!groupRow) return fail(err.notFound("Group"));
    } else if (params.principal.type === "service_account") {
      serviceAccountId = params.principal.serviceAccountId;
      const [serviceAccountRow] = await tx<{ id: string }[]>`
        SELECT id FROM auth.service_accounts
        WHERE id = ${serviceAccountId}::uuid AND status = 'active'
      `;
      if (!serviceAccountRow) return fail(err.notFound("Service account"));
    } else if (params.principal.type === "authenticated") {
      authenticatedOnly = true;
    }

    const [row] = await tx<AccessRow[]>`
      INSERT INTO auth.access (user_id, group_id, service_account_id, authenticated_only, permission)
      VALUES (
        ${userId}::uuid,
        ${groupId}::uuid,
        ${serviceAccountId}::uuid,
        ${authenticatedOnly},
        ${params.permission}::auth.permission_level
      )
      RETURNING id, user_id, group_id, service_account_id, authenticated_only, permission, created_at
    `;
    if (!row) return fail(err.internal("Failed to create access entry"));
    await tx`
      INSERT INTO pulse.base_access (base_id, access_id)
      VALUES (${params.baseId}::uuid, ${row.id}::uuid)
    `;
    return ok(row);
  });

  if (!created.ok) return fail(created.error);
  const [entry] = await resolveDisplayNames([mapAccessRow(created.data)]);
  return entry ? ok(entry) : fail(err.internal("Failed to resolve access entry"));
};

/**
 * Change or remove one base grant under the base row lock, so concurrent changes
 * see each other: the actor must still manage the base, and none of the changes
 * leaves it without a manager.
 */
const changeBaseAccess = (
  params: { baseId: string; accessId: string; user: AccessScope; locale?: string },
  permission: Exclude<PermissionLevel, "none"> | null,
): Promise<Result<void>> =>
  sql.begin(async (tx): Promise<Result<void>> => {
    await tx`SELECT id FROM pulse.bases WHERE id = ${params.baseId}::uuid FOR UPDATE`;
    const access = await requireBaseAccess(params.baseId, params.user, "admin", tx);
    if (!access.ok) return fail(access.error);
    const active = await requireBaseActive(params.baseId, tx);
    if (!active.ok) return active;
    const rows = await tx<(AccessRow & { service_account_kind: ServiceAccountKind | null })[]>`
      SELECT a.id, a.user_id, a.group_id, a.service_account_id, a.authenticated_only, a.permission, a.created_at,
             sa.kind AS service_account_kind
      FROM pulse.base_access ba
      JOIN auth.access a ON a.id = ba.access_id
      LEFT JOIN auth.service_accounts sa ON sa.id = a.service_account_id
      WHERE ba.base_id = ${params.baseId}::uuid
    `;
    const before = rows.map((row) => ({ ...mapAccessRow(row), serviceAccountKind: row.service_account_kind }));
    if (!before.some((entry) => entry.id === params.accessId)) return fail(err.notFound("Access entry"));
    const after =
      permission === null
        ? before.filter((entry) => entry.id !== params.accessId)
        : before.map((entry) => (entry.id === params.accessId ? { ...entry, permission } : entry));
    const guarded = ensureManagerRemains({ before, after, locale: params.locale });
    if (!guarded.ok) return fail(guarded.error);
    const changed =
      permission === null
        ? await tx`DELETE FROM auth.access WHERE id = ${params.accessId}::uuid`
        : await tx`UPDATE auth.access SET permission = ${permission}::auth.permission_level WHERE id = ${params.accessId}::uuid`;
    return changed.count === 0 ? fail(err.notFound("Access entry")) : ok();
  });

export const updateBaseAccess = (params: {
  baseId: string;
  accessId: string;
  user: AccessScope;
  permission: Exclude<PermissionLevel, "none">;
  locale?: string;
}): Promise<Result<void>> => changeBaseAccess(params, params.permission);

export const revokeBaseAccess = (params: { baseId: string; accessId: string; user: AccessScope; locale?: string }): Promise<Result<void>> =>
  changeBaseAccess(params, null);

export const getBase = async (baseId: string, user: AccessScope): Promise<Result<PulseBase>> => {
  const access = await requireBaseAccess(baseId, user, "read");
  if (!access.ok) return fail(access.error);
  const [row] = await sql<BaseRow[]>`
    SELECT *
    FROM pulse.bases
    WHERE id = ${baseId}::uuid
  `;
  return row ? ok(await mapBase(row)) : fail(err.notFound("Pulse base"));
};

const normalizeBaseName = (input: BaseUpdateInput, existing: BaseRow): string => input.name?.trim() || existing.name;

const normalizeBaseDescription = (input: BaseUpdateInput, existing: BaseRow): string | null =>
  input.description === undefined ? existing.description : input.description?.trim() || null;

const validateRetentionDays = (value: number, label: string): Result<number> =>
  Number.isInteger(value) && value >= 1 && value <= 3650 ? ok(value) : fail(err.badInput(`${label} must be between 1 and 3650 days`));

const validateSensitiveRetentionHours = (value: number): Result<number> =>
  Number.isInteger(value) && value >= 1 && value <= 8760
    ? ok(value)
    : fail(err.badInput("Sensitive retention must be between 1 and 8760 hours"));

const normalizeBaseUpdateValues = (input: BaseUpdateInput, existing: BaseRow): Result<BaseUpdateValues> => {
  const raw = validateRetentionDays(input.rawRetentionDays ?? existing.retention_days, "Raw retention");
  if (!raw.ok) return fail(raw.error);
  const rollup = validateRetentionDays(input.rollupRetentionDays ?? existing.rollup_retention_days, "Rollup retention");
  if (!rollup.ok) return fail(rollup.error);
  const sensitive = validateSensitiveRetentionHours(input.sensitiveRetentionHours ?? existing.sensitive_retention_hours);
  if (!sensitive.ok) return fail(sensitive.error);
  return ok({
    name: normalizeBaseName(input, existing),
    description: normalizeBaseDescription(input, existing),
    rawRetentionDays: raw.data,
    rollupRetentionDays: rollup.data,
    sensitiveRetentionHours: sensitive.data,
  });
};

const persistBaseUpdate = async (baseId: string, values: BaseUpdateValues, db: typeof sql = sql): Promise<Result<BaseRow>> => {
  const [row] = await db<BaseRow[]>`
    UPDATE pulse.bases
    SET name = ${values.name},
        description = ${values.description},
        retention_days = ${values.rawRetentionDays},
        rollup_retention_days = ${values.rollupRetentionDays},
        sensitive_retention_hours = ${values.sensitiveRetentionHours},
        updated_at = now()
    WHERE id = ${baseId}::uuid
    RETURNING *
  `;
  return row ? ok(row) : fail(err.internal("Failed to update Pulse base"));
};

export const updateBase = async (params: {
  baseId: string;
  user: AccessScope;
  name?: string;
  description?: string | null;
  rawRetentionDays?: number;
  rollupRetentionDays?: number;
  sensitiveRetentionHours?: number;
  confirmShorterRetention?: boolean;
  clock?: () => Date;
  store?: typeof baseStore;
}): Promise<Result<PulseBase>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "write");
  if (!access.ok) return access;
  const active = await requireBaseActive(params.baseId);
  if (!active.ok) return active;
  const [before] = await sql<BaseRow[]>`SELECT * FROM pulse.bases WHERE id=${params.baseId}::uuid`;
  if (!before) return fail(err.notFound("Pulse base"));
  const proposed = normalizeBaseUpdateValues(params, before);
  if (!proposed.ok) return proposed;
  const policy = await readBasePolicy();
  if (params.rawRetentionDays !== undefined && proposed.data.rawRetentionDays > policy.maxRawRetentionDays)
    return fail(err.badInput(`Raw retention must be between 1 and ${policy.maxRawRetentionDays} days`));
  // ClickHouse scans must not hold the row lock that ingest and scrapes share.
  // A confirmed save needs no preview, and so no data store.
  const preview = params.confirmShorterRetention
    ? []
    : await retentionPreview(params.baseId, before, proposed.data, params.clock, params.store).catch(() => {
        throw new RetentionStoreUnavailable();
      });
  const result = await sql.begin(async (tx): Promise<Result<BaseRow>> => {
    await tx`SELECT id FROM pulse.bases WHERE id=${params.baseId}::uuid FOR UPDATE`;
    const access = await requireBaseAccess(params.baseId, params.user, "write", tx);
    if (!access.ok) return access;
    const active = await requireBaseActive(params.baseId, tx);
    if (!active.ok) return active;
    const [existing] = await tx<BaseRow[]>`SELECT * FROM pulse.bases WHERE id=${params.baseId}::uuid`;
    if (!existing) return fail(err.notFound("Pulse base"));
    if (
      existing.retention_days !== before.retention_days ||
      existing.rollup_retention_days !== before.rollup_retention_days ||
      existing.sensitive_retention_hours !== before.sensitive_retention_hours
    )
      return fail({
        code: "PULSE_BASE_CHANGED",
        status: 409,
        message: "The base changed while the preview was computed. Review the preview again.",
      });
    if (preview.length && !params.confirmShorterRetention)
      return fail({
        code: "PULSE_RETENTION_CONFIRMATION_REQUIRED",
        status: 409,
        message: "Shorter retention removes older data. Confirm the preview to continue.",
        preview,
      });
    // Preserve unrelated concurrent name/description changes when those fields were omitted.
    const values = normalizeBaseUpdateValues(params, existing);
    if (!values.ok) return values;
    const row = await persistBaseUpdate(params.baseId, values.data, tx);
    if (row.ok) await tx`UPDATE pulse.base_stores SET reconcile_needed=true,updated_at=now() WHERE base_id=${params.baseId}::uuid`;
    return row;
  });
  if (!result.ok) return result;
  await submitBaseLifecycleJob(result.data.id, result.data.short_id);
  return ok(await mapBase(result.data));
};

export const deleteBase = async (params: { baseId: string; user: AccessScope }): Promise<Result<void>> => {
  const [existing] = await sql<BaseRow[]>`SELECT * FROM pulse.bases WHERE id = ${params.baseId}::uuid`;
  if (!existing) return fail(err.notFound("Pulse base"));

  const access = await requireBaseAccess(params.baseId, params.user, "admin");
  if (!access.ok) return fail(access.error);

  const queued = await sql.begin(async (tx): Promise<Result<void>> => {
    await tx`SELECT id FROM pulse.bases WHERE id=${params.baseId}::uuid FOR UPDATE`;
    const authorized = await requireBaseAccess(params.baseId, params.user, "admin", tx);
    if (!authorized.ok) return authorized;
    await insertBaseStore(params.baseId, await readBasePolicy(), tx);
    await tx`UPDATE pulse.base_stores SET state='deleting',operation='delete',attempts=0,updated_at=now() WHERE base_id=${params.baseId}::uuid`;
    await tx`
      UPDATE pulse.bases
      SET deletion_started_at = now(),
          deletion_failed_at = NULL,
          deletion_error = NULL,
          updated_at = now()
      WHERE id = ${params.baseId}::uuid
    `;
    await tx`
      UPDATE pulse.sources
      SET enabled = FALSE, updated_at = now()
      WHERE base_id = ${params.baseId}::uuid
    `;
    await deleteBoundServiceAccounts(params.baseId, tx);
    return ok();
  });

  if (!queued.ok) return fail(queued.error);
  await submitBaseLifecycleJob(params.baseId, existing.short_id);
  return ok();
};

export const clearBaseData = async (params: { baseId: string; user: AccessScope }): Promise<Result<void>> => {
  const [existing] = await sql<BaseRow[]>`SELECT * FROM pulse.bases WHERE id = ${params.baseId}::uuid`;
  if (!existing) return fail(err.notFound("Pulse base"));

  const access = await requireBaseAccess(params.baseId, params.user, "admin");
  if (!access.ok) return fail(access.error);

  const queued = await sql.begin(async (tx): Promise<Result<void>> => {
    await tx`SELECT id FROM pulse.bases WHERE id=${params.baseId}::uuid FOR UPDATE`;
    const active = await requireBaseActive(params.baseId, tx);
    if (!active.ok) return active;
    const authorized = await requireBaseAccess(params.baseId, params.user, "admin", tx);
    if (!authorized.ok) return authorized;
    const [store] = await tx`SELECT write_block_reason FROM pulse.base_stores WHERE base_id=${params.baseId}::uuid`;
    if (store?.write_block_reason != null)
      return fail({
        code: "PULSE_BASE_WRITE_BLOCKED",
        status: 409,
        message:
          "Writes to this base are blocked after a checkpoint mismatch. A Cloud admin decides under Administration -> Pulse -> Bases.",
      });
    // A clear gets a fresh checkpoint identity; retries of this clear keep the one its first run prepared.
    await tx`UPDATE pulse.base_stores SET state='clearing',operation='clear',pending_checkpoint_id=NULL,attempts=0,updated_at=now() WHERE base_id=${params.baseId}::uuid`;
    await tx`
      UPDATE pulse.bases
      SET data_clear_started_at = now(),
          data_clear_completed_at = NULL,
          data_clear_failed_at = NULL,
          data_clear_error = NULL,
          updated_at = now()
      WHERE id = ${params.baseId}::uuid
    `;
    return ok();
  });

  if (!queued.ok) return fail(queued.error);
  await submitBaseLifecycleJob(params.baseId, existing.short_id);
  return ok();
};
