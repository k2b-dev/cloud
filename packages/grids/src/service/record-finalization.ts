import { type DateContext, err, fail, ok, type Result } from "@k2b/stdlib";
import { getEffectiveGroupIds } from "@valentinkolb/cloud/server";
import { type SQLQuery, sql } from "bun";
import { getRecordWritableFieldType } from "../field-types";
import { logAudit, type SqlClient } from "./audit";
import { getGridsCrudMessages } from "./crud-messages";
import { captureRecordRevision, prepareRecordMutation } from "./durable-history";
import { listByTable as listFields } from "./fields";
import { assertMutationAllowed, type MutationOrigin } from "./mutation-policy";
import { allocateNumberInTransaction, bindNumberAllocation } from "./number-series";
import { requireStoredTableWritable } from "./parent-checks";
import { captureRecordEventSnapshot, enqueueRecordEvent, notifyRecordEventOutbox } from "./record-event-outbox";
import { mapRecordRow } from "./record-persistence";
import { get as getRecord } from "./record-read";
import { insertWithShortIdForDb } from "./short-id";
import type { Field, GridRecord } from "./types";

const finalizedRecordConflict = (locale?: string) => err.conflict(getGridsCrudMessages(locale).recordFinalized);

type RecordFinalizationMode = "direct" | "fourEyes";
type RecordFinalizationRequestStatus = "pending" | "approved" | "rejected" | "superseded";
type RecordFinalizationRequest = {
  id: string;
  status: RecordFinalizationRequestStatus;
  recordVersion: number;
  requestedBy: string;
  requestedByDisplayName: string;
  requestComment: string | null;
  requestedAt: string;
  resolvedBy: string | null;
  resolvedByDisplayName: string | null;
  resolutionComment: string | null;
  resolvedAt: string | null;
};

export type RecordFinalizationStatus =
  | { enabled: false; durableHistory: "disabled" | "activating" | "active" }
  | {
      enabled: true;
      durableHistory: "active";
      enabledAt: string;
      finalizedCount: number;
      canDisable: boolean;
      mode: RecordFinalizationMode;
      approverGroupId: string | null;
      approverGroupName: string | null;
      policyRevision: number;
    };

type FinalizationRequirement = { fieldId: string; fieldName: string; message: string };
export type RecordFinalizationReadiness = {
  enabled: boolean;
  mode: RecordFinalizationMode | null;
  policyRevision: number | null;
  finalized: boolean;
  finalizedAt: string | null;
  request: RecordFinalizationRequest | null;
  canResolveRequest: boolean;
  resolutionDisabledReason: string | null;
  missing: FinalizationRequirement[];
  assignedOnFinalization: Array<{ fieldId: string; fieldName: string }>;
};

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

export const assertRecordMutable = async (client: SqlClient, tableId: string, recordId: string, locale?: string): Promise<Result<void>> => {
  const messages = getGridsCrudMessages(locale);
  const [record] = await client<Array<{ finalized_at: Date | string | null }>>`
    SELECT finalized_at
    FROM grids.records
    WHERE id = ${recordId}::uuid AND table_id = ${tableId}::uuid
    FOR UPDATE
  `;
  if (!record) return fail(err.notFound(messages.record));
  return record.finalized_at ? fail(finalizedRecordConflict(locale)) : ok();
};

export const supersedePendingFinalizationRequest = async (
  client: SqlClient,
  tableId: string,
  recordId: string,
  actorId: string | null,
  reason = "The Record changed after Finalization was requested.",
): Promise<void> => {
  await client`
    UPDATE grids.record_finalization_requests
    SET status = 'superseded', resolved_by = ${actorId}::uuid, resolved_at = now(), resolution_comment = ${reason}
    WHERE table_id = ${tableId}::uuid AND record_id = ${recordId}::uuid AND status = 'pending'
  `;
};

export const getStatus = async (tableId: string, client: SqlClient = sql, locale?: string): Promise<Result<RecordFinalizationStatus>> => {
  const writable = await requireStoredTableWritable(tableId, client, locale);
  if (!writable.ok) return writable;
  const [row] = await client<
    Array<{
      enabled_at: Date | string | null;
      mode: "direct" | "four_eyes" | null;
      approver_group_id: string | null;
      approver_group_name: string | null;
      policy_revision: number | null;
      history_status: "activating" | "active" | null;
      finalized_count: number;
    }>
  >`
    SELECT activation.enabled_at, activation.mode, activation.approver_group_id::text,
           approver_group.name AS approver_group_name, activation.policy_revision,
           history.status AS history_status,
           COUNT(record.id) FILTER (WHERE record.finalized_at IS NOT NULL)::int AS finalized_count
    FROM grids.tables table_ref
    LEFT JOIN grids.durable_history_activations history ON history.table_id = table_ref.id
    LEFT JOIN grids.table_finalization_activations activation ON activation.table_id = table_ref.id
    LEFT JOIN auth.groups approver_group ON approver_group.id = activation.approver_group_id
    LEFT JOIN grids.records record ON record.table_id = table_ref.id
    WHERE table_ref.id = ${tableId}::uuid AND table_ref.deleted_at IS NULL
    GROUP BY activation.enabled_at, activation.mode, activation.approver_group_id,
             approver_group.name, activation.policy_revision, history.status
  `;
  if (!row) return fail(err.notFound(getGridsCrudMessages(locale).table));
  const durableHistory = row.history_status ?? "disabled";
  if (!row.enabled_at) return ok({ enabled: false, durableHistory });
  const finalizedCount = Number(row.finalized_count);
  return ok({
    enabled: true,
    durableHistory: "active",
    enabledAt: iso(row.enabled_at),
    finalizedCount,
    canDisable: finalizedCount === 0,
    mode: row.mode === "four_eyes" ? "fourEyes" : "direct",
    approverGroupId: row.approver_group_id,
    approverGroupName: row.approver_group_name,
    policyRevision: Number(row.policy_revision ?? 1),
  });
};

export const setPolicy = async (
  tableId: string,
  input: { mode: RecordFinalizationMode; approverGroupId?: string | null },
  actorId: string | null,
  locale?: string,
): Promise<Result<RecordFinalizationStatus>> =>
  sql.begin(async (tx): Promise<Result<RecordFinalizationStatus>> => {
    const messages = getGridsCrudMessages(locale);
    await tx`SELECT id FROM grids.tables WHERE id = ${tableId}::uuid FOR UPDATE`;
    const [activation] = await tx<Array<{ mode: "direct" | "four_eyes"; approver_group_id: string | null }>>`
      SELECT mode, approver_group_id::text
      FROM grids.table_finalization_activations
      WHERE table_id = ${tableId}::uuid
      FOR UPDATE
    `;
    if (!activation) return fail(err.badInput(messages.finalizationDisabled));
    const approverGroupId = input.mode === "fourEyes" ? (input.approverGroupId ?? null) : null;
    if (input.mode === "fourEyes" && !approverGroupId) return fail(err.badInput(messages.approverGroupRequired));
    if (approverGroupId) {
      const [group] = await tx<Array<{ id: string }>>`SELECT id::text FROM auth.groups WHERE id = ${approverGroupId}::uuid`;
      if (!group) return fail(err.badInput(messages.approverGroupNotFound));
    }
    const dbMode = input.mode === "fourEyes" ? "four_eyes" : "direct";
    if (activation.mode === dbMode && activation.approver_group_id === approverGroupId) return getStatus(tableId, tx, locale);
    await tx`
      UPDATE grids.record_finalization_requests
      SET status = 'superseded', resolved_by = ${actorId}::uuid, resolved_at = now(),
          resolution_comment = 'The Table Finalization policy changed.'
      WHERE table_id = ${tableId}::uuid AND status = 'pending'
    `;
    const [revision] = await tx<Array<{ policy_revision: number }>>`
      UPDATE grids.tables
      SET finalization_policy_revision = finalization_policy_revision + 1
      WHERE id = ${tableId}::uuid
      RETURNING finalization_policy_revision AS policy_revision
    `;
    if (!revision) return fail(err.notFound(messages.table));
    await tx`
      UPDATE grids.table_finalization_activations
      SET mode = ${dbMode}, approver_group_id = ${approverGroupId}::uuid, policy_revision = ${revision.policy_revision}
      WHERE table_id = ${tableId}::uuid
    `;
    await logAudit(
      {
        tableId,
        userId: actorId,
        action: "finalization.policy.updated",
        diff: {
          finalizationMode: {
            old: activation.mode === "four_eyes" ? "fourEyes" : "direct",
            new: input.mode,
          },
          approverGroupId: { old: activation.approver_group_id, new: approverGroupId },
        },
      },
      tx,
    );
    return getStatus(tableId, tx, locale);
  });

export const enable = async (
  tableId: string,
  input: { mode: RecordFinalizationMode; approverGroupId?: string | null },
  actorId: string | null,
  locale?: string,
): Promise<Result<RecordFinalizationStatus>> =>
  sql.begin(async (tx): Promise<Result<RecordFinalizationStatus>> => {
    const messages = getGridsCrudMessages(locale);
    const writable = await requireStoredTableWritable(tableId, tx, locale);
    if (!writable.ok) return writable;
    await tx`SELECT id FROM grids.tables WHERE id = ${tableId}::uuid FOR UPDATE`;
    const [history] = await tx<Array<{ status: string }>>`
      SELECT status FROM grids.durable_history_activations WHERE table_id = ${tableId}::uuid FOR SHARE
    `;
    if (history?.status !== "active") return fail(err.badInput(messages.durableHistoryBaselineRequired));
    const approverGroupId = input.mode === "fourEyes" ? (input.approverGroupId ?? null) : null;
    if (input.mode === "fourEyes" && !approverGroupId) return fail(err.badInput(messages.approverGroupRequired));
    if (approverGroupId) {
      const [group] = await tx<Array<{ id: string }>>`SELECT id::text FROM auth.groups WHERE id = ${approverGroupId}::uuid`;
      if (!group) return fail(err.badInput(messages.approverGroupNotFound));
    }
    const [existing] = await tx<Array<{ mode: "direct" | "four_eyes"; approver_group_id: string | null }>>`
      SELECT mode, approver_group_id::text
      FROM grids.table_finalization_activations
      WHERE table_id = ${tableId}::uuid
      FOR UPDATE
    `;
    if (existing) {
      const requestedMode = input.mode === "fourEyes" ? "four_eyes" : "direct";
      if (existing.mode !== requestedMode || existing.approver_group_id !== approverGroupId) {
        return fail(err.conflict(messages.finalizationPolicyConflict));
      }
      return getStatus(tableId, tx, locale);
    }
    const [revision] = await tx<Array<{ policy_revision: number }>>`
      UPDATE grids.tables
      SET finalization_policy_revision = finalization_policy_revision + 1
      WHERE id = ${tableId}::uuid
      RETURNING finalization_policy_revision AS policy_revision
    `;
    if (!revision) return fail(err.notFound(messages.table));
    await tx`
      INSERT INTO grids.table_finalization_activations (
        table_id, enabled_by, mode, approver_group_id, policy_revision
      ) VALUES (
        ${tableId}::uuid, ${actorId}::uuid, ${input.mode === "fourEyes" ? "four_eyes" : "direct"},
        ${approverGroupId}::uuid, ${revision.policy_revision}
      )
    `;
    await logAudit({ tableId, userId: actorId, action: "finalization.enabled", diff: { mode: { old: null, new: input.mode } } }, tx);
    return getStatus(tableId, tx, locale);
  });

export const disable = async (tableId: string, actorId: string | null, locale?: string): Promise<Result<RecordFinalizationStatus>> =>
  sql.begin(async (tx): Promise<Result<RecordFinalizationStatus>> => {
    const messages = getGridsCrudMessages(locale);
    await tx`SELECT id FROM grids.tables WHERE id = ${tableId}::uuid FOR UPDATE`;
    const [activation] = await tx<Array<{ table_id: string }>>`
      SELECT table_id::text FROM grids.table_finalization_activations WHERE table_id = ${tableId}::uuid FOR UPDATE
    `;
    if (!activation) return getStatus(tableId, tx, locale);
    const [records] = await tx<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM grids.records WHERE table_id = ${tableId}::uuid AND finalized_at IS NOT NULL
    `;
    if ((records?.count ?? 0) > 0) return fail(err.conflict(messages.finalizationCannotDisable));
    const [finalizationFields] = await tx<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM grids.fields
      WHERE table_id = ${tableId}::uuid AND deleted_at IS NULL AND type = 'id' AND config->>'assignment' = 'finalization'
    `;
    if ((finalizationFields?.count ?? 0) > 0) {
      return fail(err.conflict(messages.finalizationIdFieldsBlockDisable));
    }
    await tx`
      UPDATE grids.record_finalization_requests
      SET status = 'superseded', resolved_by = ${actorId}::uuid, resolved_at = now(),
          resolution_comment = 'Finalization was disabled for the Table.'
      WHERE table_id = ${tableId}::uuid AND status = 'pending'
    `;
    await tx`DELETE FROM grids.table_finalization_activations WHERE table_id = ${tableId}::uuid`;
    await logAudit({ tableId, userId: actorId, action: "finalization.disabled" }, tx);
    return getStatus(tableId, tx, locale);
  });

const loadRecordValues = async (
  client: SqlClient,
  tableId: string,
  recordId: string,
): Promise<{ row: Record<string, unknown>; data: Record<string, unknown> } | null> => {
  const [row] = await client<Array<Record<string, unknown>>>`
    SELECT record.*
    FROM grids.records record
    WHERE record.id = ${recordId}::uuid AND record.table_id = ${tableId}::uuid
      AND record.deleted_at IS NULL
  `;
  if (!row) return null;
  const data = { ...mapRecordRow(row).data };
  const relations = await client<Array<{ field_id: string; record_ids: string[] }>>`
    SELECT from_field_id::text AS field_id, array_agg(to_record_id::text ORDER BY position, to_record_id) AS record_ids
    FROM grids.record_links WHERE from_record_id = ${recordId}::uuid GROUP BY from_field_id
  `;
  for (const relation of relations) data[relation.field_id] = relation.record_ids;
  return { row, data };
};

const requirements = async (
  client: SqlClient,
  recordId: string,
  fields: Field[],
  data: Record<string, unknown>,
  locale?: string,
): Promise<{ missing: FinalizationRequirement[]; assignedOnFinalization: Array<{ fieldId: string; fieldName: string }> }> => {
  const messages = getGridsCrudMessages(locale);
  const missing: FinalizationRequirement[] = [];
  const assignedOnFinalization: Array<{ fieldId: string; fieldName: string }> = [];
  const invalidRelations = new Set(
    (
      await client<Array<{ field_id: string }>>`
        SELECT DISTINCT link.from_field_id::text AS field_id
        FROM grids.record_links link
        JOIN grids.fields field ON field.id = link.from_field_id AND field.deleted_at IS NULL
        LEFT JOIN grids.records target ON target.id = link.to_record_id
          AND target.table_id::text = field.config->>'targetTableId'
          AND target.deleted_at IS NULL
        LEFT JOIN grids.tables target_table ON target_table.id = target.table_id AND target_table.deleted_at IS NULL
        LEFT JOIN grids.bases target_base ON target_base.id = target_table.base_id AND target_base.deleted_at IS NULL
        WHERE link.from_record_id = ${recordId}::uuid
          AND (target.id IS NULL OR target_table.id IS NULL OR target_base.id IS NULL)
      `
    ).map((row) => row.field_id),
  );
  for (const field of fields) {
    if (field.type === "id") {
      if (data[field.id] != null) continue;
      if ((field.config as { assignment?: string }).assignment === "finalization") {
        assignedOnFinalization.push({ fieldId: field.id, fieldName: field.name });
      } else {
        missing.push({ fieldId: field.id, fieldName: field.name, message: messages.generatedIdMissing });
      }
      continue;
    }
    if (field.type === "file") {
      if (!field.required) continue;
      const [count] = await client<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM grids.file_attachments
        WHERE record_id = ${recordId}::uuid AND field_id = ${field.id}::uuid
      `;
      if ((count?.count ?? 0) === 0) missing.push({ fieldId: field.id, fieldName: field.name, message: messages.requiredFileMissing });
      continue;
    }
    if (field.type === "relation" && invalidRelations.has(field.id)) {
      missing.push({ fieldId: field.id, fieldName: field.name, message: messages.linkedRecordUnavailable });
      continue;
    }
    const handler = getRecordWritableFieldType(field.type);
    if (!handler) continue;
    const result = handler.validate(data[field.id], field.config, field.required);
    if (!result.ok) {
      missing.push({
        fieldId: field.id,
        fieldName: field.name,
        message: result.error === "required" ? messages.valueRequired : result.error,
      });
    }
  }
  return { missing, assignedOnFinalization };
};

type FinalizationRequestRow = {
  id: string;
  short_id: string;
  record_version: number;
  policy_revision: number;
  status: RecordFinalizationRequestStatus;
  requested_by: string;
  requested_by_display_name: string;
  request_comment: string | null;
  requested_at: Date | string;
  resolved_by: string | null;
  resolved_by_display_name: string | null;
  resolution_comment: string | null;
  resolved_at: Date | string | null;
};

const mapFinalizationRequest = (row: FinalizationRequestRow): RecordFinalizationRequest => ({
  id: row.short_id,
  status: row.status,
  recordVersion: Number(row.record_version),
  requestedBy: row.requested_by,
  requestedByDisplayName: row.requested_by_display_name,
  requestComment: row.request_comment,
  requestedAt: iso(row.requested_at),
  resolvedBy: row.resolved_by,
  resolvedByDisplayName: row.resolved_by_display_name,
  resolutionComment: row.resolution_comment,
  resolvedAt: row.resolved_at ? iso(row.resolved_at) : null,
});

const finalizationRequestRows = (client: SqlClient, where: SQLQuery, lock = false): Promise<FinalizationRequestRow[]> => client<
  FinalizationRequestRow[]
>`
  SELECT request.id::text, request.short_id, request.record_version, request.policy_revision, request.status,
         request.requested_by::text,
         COALESCE(NULLIF(requester.display_name, ''), requester.uid, 'Unknown user') AS requested_by_display_name,
         request.request_comment, request.requested_at, request.resolved_by::text,
         CASE WHEN resolver.id IS NULL THEN NULL ELSE COALESCE(NULLIF(resolver.display_name, ''), resolver.uid, 'Unknown user') END
           AS resolved_by_display_name,
         request.resolution_comment, request.resolved_at
  FROM grids.record_finalization_requests request
  JOIN auth.users requester ON requester.id = request.requested_by
  LEFT JOIN auth.users resolver ON resolver.id = request.resolved_by
  WHERE ${where}
  ORDER BY request.requested_at DESC, request.id DESC
  LIMIT 1
  ${lock ? sql`FOR UPDATE OF request` : sql``}
`;

const latestFinalizationRequest = async (
  client: SqlClient,
  tableId: string,
  recordId: string,
): Promise<{ request: RecordFinalizationRequest; internalId: string; policyRevision: number } | null> => {
  const [row] = await finalizationRequestRows(client, sql`request.table_id = ${tableId}::uuid AND request.record_id = ${recordId}::uuid`);
  return row ? { request: mapFinalizationRequest(row), internalId: row.id, policyRevision: Number(row.policy_revision) } : null;
};

export const inspect = async (params: {
  tableId: string;
  recordId: string;
  actorId?: string | null;
  client?: SqlClient;
  locale?: string;
}): Promise<Result<RecordFinalizationReadiness>> => {
  const messages = getGridsCrudMessages(params.locale);
  const client = params.client ?? sql;
  const status = await getStatus(params.tableId, client, params.locale);
  if (!status.ok) return status;
  const record = await loadRecordValues(client, params.tableId, params.recordId);
  if (!record) return fail(err.notFound(messages.record));
  const finalizedAt = record.row.finalized_at ? iso(record.row.finalized_at as Date | string) : null;
  const fields = await listFields(params.tableId, false, client);
  const checked = await requirements(client, params.recordId, fields, record.data, params.locale);
  const storedRequest = await latestFinalizationRequest(client, params.tableId, params.recordId);
  const request =
    storedRequest?.request.status === "pending" &&
    (storedRequest.request.recordVersion !== Number(record.row.version) ||
      (status.data.enabled && storedRequest.policyRevision !== status.data.policyRevision))
      ? { ...storedRequest.request, status: "superseded" as const }
      : (storedRequest?.request ?? null);
  let canResolveRequest = false;
  let resolutionDisabledReason: string | null = null;
  if (request?.status === "pending" && status.data.enabled && status.data.mode === "fourEyes") {
    if (!params.actorId) resolutionDisabledReason = messages.finalizationSignInToResolve;
    else if (request.requestedBy === params.actorId) resolutionDisabledReason = messages.finalizationDifferentResolver;
    else if (!status.data.approverGroupId) resolutionDisabledReason = messages.finalizationApproverGroupMissing;
    else if (!(await getEffectiveGroupIds({ userId: params.actorId }, client)).includes(status.data.approverGroupId)) {
      resolutionDisabledReason = messages.finalizationApproverGroupOnly;
    } else canResolveRequest = true;
  }
  return ok({
    enabled: status.data.enabled,
    mode: status.data.enabled ? status.data.mode : null,
    policyRevision: status.data.enabled ? status.data.policyRevision : null,
    finalized: finalizedAt !== null,
    finalizedAt,
    request,
    canResolveRequest,
    resolutionDisabledReason,
    ...checked,
  });
};

export const requestFinalizationInTransaction = async (
  client: SqlClient,
  params: {
    tableId: string;
    recordId: string;
    actorId: string | null;
    comment?: string | null;
    expectedPolicyRevision?: number;
    locale?: string;
  },
): Promise<Result<RecordFinalizationRequest>> => {
  const messages = getGridsCrudMessages(params.locale);
  if (!params.actorId) return fail(err.forbidden(messages.finalizationRequestUserRequired));
  const [activation] = await client<Array<{ mode: string; policy_revision: number }>>`
      SELECT mode, policy_revision
      FROM grids.table_finalization_activations
      WHERE table_id = ${params.tableId}::uuid
      FOR SHARE
  `;
  if (!activation) return fail(err.badInput(messages.finalizationDisabled));
  if (params.expectedPolicyRevision !== undefined && Number(activation.policy_revision) !== Number(params.expectedPolicyRevision)) {
    return fail(err.conflict(messages.finalizationPolicyChangedAfterPreview));
  }
  if (activation.mode !== "four_eyes") return fail(err.conflict(messages.directFinalizationOnly));
  const [record] = await client<Array<{ version: number; finalized_at: Date | null }>>`
      SELECT record.version, record.finalized_at
      FROM grids.records record
      WHERE record.id = ${params.recordId}::uuid AND record.table_id = ${params.tableId}::uuid
        AND record.deleted_at IS NULL
      FOR UPDATE
    `;
  if (!record) return fail(err.notFound(messages.record));
  if (record.finalized_at) return fail(finalizedRecordConflict(params.locale));
  const [pending] = await finalizationRequestRows(
    client,
    sql`request.table_id = ${params.tableId}::uuid AND request.record_id = ${params.recordId}::uuid AND request.status = 'pending'`,
    true,
  );
  if (pending) {
    const currentRequest =
      pending.requested_by === params.actorId &&
      Number(pending.record_version) === Number(record.version) &&
      Number(pending.policy_revision) === Number(activation.policy_revision);
    if (currentRequest) return ok(mapFinalizationRequest(pending));
    const staleRequest =
      Number(pending.record_version) !== Number(record.version) || Number(pending.policy_revision) !== Number(activation.policy_revision);
    if (!staleRequest) {
      return fail(err.conflict(messages.finalizationRequestPending));
    }
    await client`
        UPDATE grids.record_finalization_requests
        SET status = 'superseded', resolved_by = ${params.actorId}::uuid, resolved_at = now(),
            resolution_comment = 'The Record or Table Finalization policy changed.'
        WHERE id = ${pending.id}::uuid AND status = 'pending'
      `;
  }
  const loaded = await loadRecordValues(client, params.tableId, params.recordId);
  if (!loaded) return fail(err.notFound(messages.record));
  const fields = await listFields(params.tableId, false, client);
  const checked = await requirements(client, params.recordId, fields, loaded.data, params.locale);
  if (checked.missing.length > 0) {
    return fail(err.badInput(messages.recordNotReady({ fields: checked.missing.map((item) => item.fieldName).join(", ") })));
  }
  await insertWithShortIdForDb(client, "idx_grids_record_finalization_requests_short_id", async (attempt, shortId) => {
    await attempt`
        INSERT INTO grids.record_finalization_requests (
          short_id, table_id, record_id, record_version, policy_revision, requested_by, request_comment
        ) VALUES (
          ${shortId}, ${params.tableId}::uuid, ${params.recordId}::uuid, ${record.version}, ${activation.policy_revision},
          ${params.actorId}::uuid, ${params.comment ?? null}
        )
      `;
  });
  await logAudit(
    {
      tableId: params.tableId,
      recordId: params.recordId,
      userId: params.actorId,
      action: "finalization.requested",
      diff: { finalizationRequest: { old: null, new: "pending" } },
    },
    client,
  );
  const created = await latestFinalizationRequest(client, params.tableId, params.recordId);
  return created ? ok(created.request) : fail(err.notFound(messages.finalizationRequest));
};

export const requestFinalization = async (params: {
  tableId: string;
  recordId: string;
  actorId: string | null;
  comment?: string | null;
  expectedPolicyRevision?: number;
  locale?: string;
}): Promise<Result<RecordFinalizationRequest>> => sql.begin((tx) => requestFinalizationInTransaction(tx, params));

const validateResolver = async (
  client: SqlClient,
  params: { tableId: string; recordId: string; requestId: string; actorId: string | null; locale?: string },
  operation: "approve" | "reject",
): Promise<Result<{ request: FinalizationRequestRow; approverGroupId: string; replay: boolean }>> => {
  const messages = getGridsCrudMessages(params.locale);
  if (!params.actorId) return fail(err.forbidden(messages.finalizationResolveUserRequired));
  const [activation] = await client<Array<{ mode: string; approver_group_id: string | null; policy_revision: number }>>`
    SELECT mode, approver_group_id::text, policy_revision
    FROM grids.table_finalization_activations
    WHERE table_id = ${params.tableId}::uuid
    FOR SHARE
  `;
  if (!activation || activation.mode !== "four_eyes" || !activation.approver_group_id) {
    return fail(err.conflict(messages.fourEyesNotEnabled));
  }
  const [record] = await client<Array<{ version: number; deleted_at: Date | null; finalized_at: Date | null }>>`
    SELECT version, deleted_at, finalized_at
    FROM grids.records
    WHERE id = ${params.recordId}::uuid AND table_id = ${params.tableId}::uuid
    FOR UPDATE
  `;
  if (!record) return fail(err.notFound(messages.record));
  const [request] = await finalizationRequestRows(
    client,
    sql`request.table_id = ${params.tableId}::uuid AND request.record_id = ${params.recordId}::uuid AND request.short_id = ${params.requestId}`,
    true,
  );
  if (!request) return fail(err.notFound(messages.finalizationRequest));
  if (request.status !== "pending") {
    const replayStatus = operation === "approve" ? "approved" : "rejected";
    if (request.status === replayStatus && request.resolved_by === params.actorId) {
      return ok({ request, approverGroupId: activation.approver_group_id, replay: true });
    }
    return fail(err.conflict(messages.finalizationRequestResolved));
  }
  if (request.requested_by === params.actorId) return fail(err.forbidden(messages.ownFinalizationRequest));
  if (Number(request.policy_revision) !== Number(activation.policy_revision)) {
    await client`
      UPDATE grids.record_finalization_requests
      SET status = 'superseded', resolved_by = ${params.actorId}::uuid, resolved_at = now(),
          resolution_comment = 'The Table Finalization policy changed.'
      WHERE id = ${request.id}::uuid AND status = 'pending'
    `;
    return fail(err.conflict(messages.finalizationPolicyChanged));
  }
  const groupIds = await getEffectiveGroupIds({ userId: params.actorId }, client);
  if (!groupIds.includes(activation.approver_group_id)) {
    return fail(err.forbidden(messages.approverMembershipRequired));
  }
  if (record.deleted_at || record.finalized_at || Number(record.version) !== Number(request.record_version)) {
    await client`
      UPDATE grids.record_finalization_requests
      SET status = 'superseded', resolved_by = ${params.actorId}::uuid, resolved_at = now(),
          resolution_comment = 'The Record changed after Finalization was requested.'
      WHERE id = ${request.id}::uuid AND status = 'pending'
    `;
    return fail(err.conflict(messages.recordChangedAfterRequest));
  }
  return ok({ request, approverGroupId: activation.approver_group_id, replay: false });
};

const resolvedReplay = async (
  client: SqlClient,
  params: { tableId: string; recordId: string; requestId: string; actorId: string | null; locale?: string },
  operation: "approve" | "reject",
): Promise<Result<FinalizationRequestRow | null>> => {
  const messages = getGridsCrudMessages(params.locale);
  if (!params.actorId) return fail(err.forbidden(messages.finalizationResolveUserRequired));
  const [request] = await finalizationRequestRows(
    client,
    sql`request.table_id = ${params.tableId}::uuid AND request.record_id = ${params.recordId}::uuid
        AND request.short_id = ${params.requestId} AND request.status <> 'pending'`,
    true,
  );
  if (!request) return ok(null);
  const replayStatus = operation === "approve" ? "approved" : "rejected";
  if (request.status === replayStatus && request.resolved_by === params.actorId) return ok(request);
  return fail(err.conflict(messages.finalizationRequestResolved));
};

export const finalizeInTransaction = async (
  client: SqlClient,
  params: {
    tableId: string;
    recordId: string;
    actorId: string | null;
    origin: MutationOrigin;
    approvalRequestId?: string;
    expectedPolicyRevision?: number;
    dateConfig?: DateContext;
    locale?: string;
  },
): Promise<Result<{ record: GridRecord; outboxId: string | null; approvalRequestInternalId?: string; approvalReplay?: boolean }>> => {
  const messages = getGridsCrudMessages(params.locale);
  const writable = await requireStoredTableWritable(params.tableId, client, params.locale);
  if (!writable.ok) return writable;
  const allowed = await assertMutationAllowed(client, params.tableId, params.origin, params.locale);
  if (!allowed.ok) return allowed;
  const [target] = await client<Array<{ id: string }>>`
    SELECT record.id::text
    FROM grids.records record
    WHERE record.id = ${params.recordId}::uuid AND record.table_id = ${params.tableId}::uuid
      AND record.deleted_at IS NULL
  `;
  if (!target) return fail(err.notFound(messages.record));
  const [activation] = await client<Array<{ table_id: string; mode: "direct" | "four_eyes"; policy_revision: number }>>`
    SELECT table_id::text, mode, policy_revision FROM grids.table_finalization_activations
    WHERE table_id = ${params.tableId}::uuid FOR SHARE
  `;
  if (!activation) return fail(err.badInput(messages.finalizationDisabled));
  if (params.expectedPolicyRevision !== undefined && Number(activation.policy_revision) !== Number(params.expectedPolicyRevision)) {
    return fail(err.conflict(messages.finalizationPolicyChangedAfterPreview));
  }
  if (params.approvalRequestId) {
    const admission = await validateResolver(client, { ...params, requestId: params.approvalRequestId }, "approve");
    if (!admission.ok) return admission;
    if (admission.data.replay) {
      const replayed = await loadRecordValues(client, params.tableId, params.recordId);
      if (!replayed?.row.finalized_at) return fail(err.conflict(messages.approvedRequestMismatch));
      return ok({
        record: mapRecordRow(replayed.row),
        outboxId: null,
        approvalRequestInternalId: admission.data.request.id,
        approvalReplay: true,
      });
    }
    params = { ...params, approvalRequestId: admission.data.request.id };
  } else if (activation.mode === "four_eyes") {
    return fail(err.conflict(messages.fourEyesRequestRequired));
  }
  await prepareRecordMutation(client, params.tableId, params.recordId);
  const record = await loadRecordValues(client, params.tableId, params.recordId);
  if (!record) return fail(err.notFound(messages.record));
  if (record.row.finalized_at) return ok({ record: mapRecordRow(record.row), outboxId: null });

  const fields = await listFields(params.tableId, false, client);
  const checked = await requirements(client, params.recordId, fields, record.data, params.locale);
  if (checked.missing.length > 0) {
    return fail(err.badInput(messages.recordNotReady({ fields: checked.missing.map((item) => item.fieldName).join(", ") })));
  }

  const data = { ...mapRecordRow(record.row).data };
  const allocations: Array<{ id: string; fieldId: string; value: string }> = [];
  for (const field of fields) {
    if (field.type !== "id" || (field.config as { assignment?: string }).assignment !== "finalization" || data[field.id] != null) continue;
    const allocation = await allocateNumberInTransaction({
      client,
      owner: { kind: "field", id: field.id },
      expectedAssignment: "finalization",
      dateConfig: params.dateConfig,
    });
    data[field.id] = allocation.renderedValue;
    allocations.push({ id: allocation.id, fieldId: field.id, value: allocation.renderedValue });
  }

  const changedFieldIds = allocations.map((allocation) => allocation.fieldId);
  const nextVersion = Number(record.row.version) + 1;
  const [updated] = await client<Array<Record<string, unknown>>>`
    UPDATE grids.records
    SET data = ${data}::jsonb, version = ${nextVersion}, updated_by = ${params.actorId}::uuid, updated_at = now()
    WHERE id = ${params.recordId}::uuid AND table_id = ${params.tableId}::uuid
      AND deleted_at IS NULL AND finalized_at IS NULL
    RETURNING *
  `;
  if (!updated) return fail(finalizedRecordConflict(params.locale));
  for (const allocation of allocations) await bindNumberAllocation(client, allocation.id, { kind: "record", id: params.recordId });
  const revision = await captureRecordRevision(client, {
    tableId: params.tableId,
    recordId: params.recordId,
    action: "finalized",
    changedFieldIds,
    actorId: params.actorId,
    schemaFields: fields,
  });
  if (!revision) throw new Error("Finalization requires active Durable History.");
  const [finalized] = await client<Array<Record<string, unknown>>>`
    UPDATE grids.records
    SET finalized_at = now(), finalized_by = ${params.actorId}::uuid, final_revision_id = ${revision.id}::uuid
    WHERE id = ${params.recordId}::uuid AND finalized_at IS NULL
    RETURNING *
  `;
  if (!finalized) throw new Error("record finalization marker was not written");
  const outboxId = await enqueueRecordEvent(client, {
    type: "record.finalized",
    baseId: (await client<Array<{ base_id: string }>>`SELECT base_id::text FROM grids.tables WHERE id = ${params.tableId}::uuid`)[0]!
      .base_id,
    tableId: params.tableId,
    recordId: params.recordId,
    version: nextVersion,
    changedFieldIds,
    actorId: params.actorId,
  });
  await captureRecordEventSnapshot(client, {
    snapshotId: outboxId,
    tableId: params.tableId,
    recordId: params.recordId,
    eventType: "record.finalized",
  });
  await logAudit({ tableId: params.tableId, recordId: params.recordId, userId: params.actorId, action: "finalized" }, client);
  return ok({
    record: mapRecordRow(finalized),
    outboxId,
    approvalRequestInternalId: params.approvalRequestId,
    approvalReplay: false,
  });
};

export const finalize = async (params: {
  tableId: string;
  recordId: string;
  actorId: string | null;
  origin: MutationOrigin;
  dateConfig?: DateContext;
  locale?: string;
}): Promise<Result<GridRecord>> => {
  const result = await sql.begin((tx) => finalizeInTransaction(tx, params));
  if (!result.ok) return result;
  if (result.data.outboxId) notifyRecordEventOutbox(result.data.outboxId);
  const record = await getRecord(params.tableId, params.recordId, {
    dateConfig: params.dateConfig,
  });
  return record ? ok(record) : fail(err.notFound(getGridsCrudMessages(params.locale).record));
};

export const approveFinalization = async (params: {
  tableId: string;
  recordId: string;
  requestId: string;
  actorId: string | null;
  comment?: string | null;
  dateConfig?: DateContext;
  locale?: string;
}): Promise<Result<GridRecord>> => {
  const messages = getGridsCrudMessages(params.locale);
  const result = await sql.begin(async (tx): Promise<Result<{ record: GridRecord; outboxId: string | null }>> => {
    const replay = await resolvedReplay(tx, params, "approve");
    if (!replay.ok) return replay;
    if (replay.data) {
      const record = await loadRecordValues(tx, params.tableId, params.recordId);
      if (!record?.row.finalized_at) return fail(err.conflict(messages.approvedRequestMismatch));
      return ok({ record: mapRecordRow(record.row), outboxId: null });
    }
    const finalized = await finalizeInTransaction(tx, {
      tableId: params.tableId,
      recordId: params.recordId,
      actorId: params.actorId,
      origin: "direct",
      approvalRequestId: params.requestId,
      dateConfig: params.dateConfig,
      locale: params.locale,
    });
    if (!finalized.ok) return finalized;
    if (finalized.data.approvalReplay) return finalized;
    await tx`
      UPDATE grids.record_finalization_requests
      SET status = 'approved', resolved_by = ${params.actorId}::uuid, resolved_at = now(),
          resolution_comment = ${params.comment ?? null}
      WHERE id = ${finalized.data.approvalRequestInternalId}::uuid AND status = 'pending'
    `;
    await logAudit(
      {
        tableId: params.tableId,
        recordId: params.recordId,
        userId: params.actorId,
        action: "finalization.request.approved",
        diff: { finalizationRequest: { old: "pending", new: "approved" } },
      },
      tx,
    );
    return finalized;
  });
  if (!result.ok) return result;
  if (result.data.outboxId) notifyRecordEventOutbox(result.data.outboxId);
  const record = await getRecord(params.tableId, params.recordId, {
    dateConfig: params.dateConfig,
  });
  return record ? ok(record) : fail(err.notFound(messages.record));
};

export const rejectFinalization = async (params: {
  tableId: string;
  recordId: string;
  requestId: string;
  actorId: string | null;
  comment?: string | null;
  locale?: string;
}): Promise<Result<RecordFinalizationRequest>> =>
  sql.begin(async (tx): Promise<Result<RecordFinalizationRequest>> => {
    const replay = await resolvedReplay(tx, params, "reject");
    if (!replay.ok) return replay;
    if (replay.data) return ok(mapFinalizationRequest(replay.data));
    const admission = await validateResolver(tx, params, "reject");
    if (!admission.ok) return admission;
    if (admission.data.replay) return ok(mapFinalizationRequest(admission.data.request));
    await tx`
      UPDATE grids.record_finalization_requests
      SET status = 'rejected', resolved_by = ${params.actorId}::uuid, resolved_at = now(),
          resolution_comment = ${params.comment ?? null}
      WHERE id = ${admission.data.request.id}::uuid AND status = 'pending'
    `;
    await logAudit(
      {
        tableId: params.tableId,
        recordId: params.recordId,
        userId: params.actorId,
        action: "finalization.request.rejected",
        diff: { finalizationRequest: { old: "pending", new: "rejected" } },
      },
      tx,
    );
    const rejected = await latestFinalizationRequest(tx, params.tableId, params.recordId);
    return rejected ? ok(rejected.request) : fail(err.notFound(getGridsCrudMessages(params.locale).finalizationRequest));
  });
