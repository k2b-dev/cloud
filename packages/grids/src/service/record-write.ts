import { type DateContext, err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { RecordMutationAudit } from "../contracts";
import { getRecordWritableFieldType, isRecordWritableFieldType } from "../field-types";
import { logAudit, type SqlClient } from "./audit";
import { getGridsCrudMessages } from "./crud-messages";
import { captureRecordRevision, lockDurableHistoryMutationBoundary, prepareRecordMutation } from "./durable-history";
import { listByTable as listFields, materializeFieldDefault } from "./fields";
import { generatedIdRequiresRetry, generateIdValue, isGeneratedIdUniqueCollision } from "./generated-ids";
import { assertMutationAllowed, type MutationOrigin } from "./mutation-policy";
import { bindFieldNumberAllocations } from "./number-series";
import { requireStoredTableWritable } from "./parent-checks";
import { validatePrincipalValuesForActor } from "./principal-values";
import { buildRecordAuditContext, loadTableAuditPolicy } from "./record-audit";
import { captureRecordEventSnapshot, notifyRecordEventOutbox } from "./record-event-outbox";
import { assertRecordMutable, supersedePendingFinalizationRequest } from "./record-finalization";
import { buildPersistedUpdateData, buildRecordDiff, mapRecordRow, splitRelationsFromData } from "./record-persistence";
import { createReader, get } from "./record-read";
import { recordUniqueConflict } from "./record-unique-conflicts";
import { resolveReadableTableIds } from "./relation-access";
import { type ExpansionViewer, enrichRecordsWithFormulas, validateRelationTargets, writeRecordLinks } from "./relations";
import { insertWithShortIdForDb } from "./short-id";
import type { Field, GridRecord } from "./types";

type DbRow = Record<string, unknown>;

const recordVersionConflict = (locale?: string) => ({
  code: "CONFLICT" as const,
  status: 409 as const,
  message: getGridsCrudMessages(locale).recordChanged,
});

const formatFieldValidationError = (fieldName: string, validationError: string, locale?: string): string => {
  const messages = getGridsCrudMessages(locale);
  return validationError === "required"
    ? messages.fieldRequired({ field: fieldName })
    : messages.fieldInvalid({ field: fieldName, detail: validationError });
};

/**
 * Pre-flight relation-target existence, batched per targetTableId. The
 * naive shape (one validateRelationTargets call per relation field)
 * makes N round-trips when N fields point at the same target table; the
 * batched shape collapses to one call per distinct target table. The FK
 * inside the write transaction is the actual safety net — this just
 * gives a clean 400 with a useful "missing target records" message
 * instead of letting a 23503 leak through.
 */
const preflightRelationTargets = async (
  relations: Map<string, string[]>, // fieldId -> toIds
  fieldsById: Map<string, Field>,
  client: SqlClient = sql,
  viewer?: ExpansionViewer,
  locale?: string,
): Promise<Result<void>> => {
  const messages = getGridsCrudMessages(locale);
  // Group all (fieldId, toIds) by their relation field's targetTableId.
  // Track which fields contributed to each group so we can attribute
  // missing-target errors back to the right field name in the message.
  const groups = new Map<string, { ids: Set<string>; fieldNames: string[] }>();
  for (const [fieldId, toIds] of relations) {
    const f = fieldsById.get(fieldId);
    const targetTableId = (f?.config as { targetTableId?: string } | undefined)?.targetTableId;
    if (!targetTableId) continue;
    const g = groups.get(targetTableId) ?? { ids: new Set<string>(), fieldNames: [] };
    for (const id of toIds) g.ids.add(id);
    if (toIds.length > 0 && f) g.fieldNames.push(f.name);
    groups.set(targetTableId, g);
  }

  const authorizedTableIds = viewer ? await resolveReadableTableIds(groups.keys(), viewer, client) : null;
  for (const [targetTableId, group] of groups) {
    const ids = [...group.ids];
    if (ids.length === 0) continue;
    const check =
      authorizedTableIds && !authorizedTableIds.has(targetTableId)
        ? { ok: false as const, missing: ids }
        : await validateRelationTargets(targetTableId, ids, client);
    if (!check.ok) {
      const fieldNamePart = group.fieldNames.map((name) => `“${name}”`).join(", ");
      return fail(err.badInput(messages.relationTargetsUnavailable({ fields: fieldNamePart, count: check.missing.length })));
    }
  }
  return ok();
};

/**
 * Create-path validation: every user-writable field is materialized using
 * either the provided value or the field's default. Required-checks apply.
 * Generated ID fields receive a server-generated value.
 */
const validateForCreate = async (
  tableId: string,
  payload: Record<string, unknown>,
  options: { actorId: string | null; dateConfig?: DateContext; client?: SqlClient; fields?: Field[]; locale?: string },
): Promise<Result<Record<string, unknown>>> => {
  const messages = getGridsCrudMessages(options.locale);
  const fields = options.fields ?? (await listFields(tableId, false, options.client));
  const fieldsById = new Map(fields.map((f) => [f.id, f]));

  for (const key of Object.keys(payload)) {
    const field = fieldsById.get(key);
    if (!field) return fail(err.badInput(messages.unknownField));
    if (!isRecordWritableFieldType(field.type)) {
      return fail(err.badInput(messages.fieldNotWritable({ field: field.name })));
    }
  }

  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.type === "id") {
      if ((field.config as { assignment?: string }).assignment === "finalization") continue;
      out[field.id] = await generateIdValue(field, {
        dateConfig: options.dateConfig,
      });
      continue;
    }
    const handler = getRecordWritableFieldType(field.type);
    if (!handler) continue;

    const provided = Object.prototype.hasOwnProperty.call(payload, field.id);
    const raw = provided ? payload[field.id] : materializeFieldDefault(field, { dateConfig: options.dateConfig });
    const result = handler.validate(raw, field.config, field.required);
    if (!result.ok) return fail(err.badInput(formatFieldValidationError(field.name, result.error, options.locale)));
    if (result.value !== null && result.value !== undefined) {
      out[field.id] = result.value;
    }
  }
  const principals = await validatePrincipalValuesForActor(out, fields, options.actorId, options.locale);
  return principals.ok ? ok(out) : principals;
};

/**
 * Update-path validation: ONLY the fields present in the payload are validated.
 * Omitted fields are left to the merge step in `update()` to preserve existing
 * values. Explicit `null` is a clear-the-field intent and must round-trip.
 */
const validateForUpdate = async (
  tableId: string,
  payload: Record<string, unknown>,
  fields: Field[],
  actorId: string | null,
  locale?: string,
): Promise<Result<Record<string, unknown>>> => {
  const messages = getGridsCrudMessages(locale);
  const fieldsById = new Map(fields.map((f) => [f.id, f]));

  for (const key of Object.keys(payload)) {
    if (!fieldsById.has(key)) return fail(err.badInput(messages.unknownField));
  }

  const out: Record<string, unknown> = {};
  for (const [fieldId, raw] of Object.entries(payload)) {
    const field = fieldsById.get(fieldId)!;
    const handler = getRecordWritableFieldType(field.type);
    if (!handler) {
      return fail(err.badInput(messages.fieldNotWritable({ field: field.name })));
    }
    const result = handler.validate(raw, field.config, field.required);
    if (!result.ok) return fail(err.badInput(formatFieldValidationError(field.name, result.error, locale)));
    out[fieldId] = result.value;
  }
  const principals = await validatePrincipalValuesForActor(out, fields, actorId, locale);
  return principals.ok ? ok(out) : principals;
};

/** Keep update preflight on the caller's transaction connection once parent
 * locks are held; a pool read here can deadlock behind concurrent schema DDL. */
const loadStoredRecordForUpdate = async (
  client: SqlClient,
  tableId: string,
  recordId: string,
  fields: Field[],
): Promise<GridRecord | null> => {
  const [row] = await client<DbRow[]>`
    SELECT r.*
    FROM grids.records r
    WHERE r.id = ${recordId}::uuid
      AND r.table_id = ${tableId}::uuid
      AND r.deleted_at IS NULL
  `;
  if (!row) return null;

  const record = mapRecordRow(row);
  const relationFieldIds = fields.filter((field) => field.type === "relation").map((field) => field.id);
  if (relationFieldIds.length === 0) return record;

  const links = await client<Array<{ from_field_id: string; to_record_id: string }>>`
    SELECT from_field_id::text, to_record_id::text
    FROM grids.record_links
    WHERE from_record_id = ${recordId}::uuid
      AND from_field_id = ANY(${client.array(relationFieldIds, "UUID")})
    ORDER BY from_field_id, position
  `;
  const targetsByField = new Map<string, string[]>();
  for (const link of links) {
    const targets = targetsByField.get(link.from_field_id) ?? [];
    targets.push(link.to_record_id);
    targetsByField.set(link.from_field_id, targets);
  }
  for (const fieldId of relationFieldIds) record.data[fieldId] = targetsByField.get(fieldId) ?? [];
  return record;
};

type CreateRecordInTransactionResult = {
  record: GridRecord;
  changedFieldIds: string[];
  outboxId: string;
};

export const createInTransaction = async (
  client: SqlClient,
  tableId: string,
  payload: Record<string, unknown>,
  actorId: string | null,
  origin: MutationOrigin,
  opts: {
    dateConfig?: DateContext;
    viewer?: ExpansionViewer;
    locale?: string;
  } = {},
): Promise<Result<CreateRecordInTransactionResult>> => {
  const messages = getGridsCrudMessages(opts.locale);
  const writable = await requireStoredTableWritable(tableId, client, opts.locale);
  if (!writable.ok) return writable;
  const allowed = await assertMutationAllowed(client, tableId, origin, opts.locale);
  if (!allowed.ok) return allowed;
  await lockDurableHistoryMutationBoundary(client, tableId);

  if (origin !== "form") {
    const [row] = await client<{ disable_direct_insert: boolean }[]>`
      SELECT disable_direct_insert FROM grids.tables WHERE id = ${tableId}::uuid AND deleted_at IS NULL
    `;
    if (row?.disable_direct_insert) {
      return fail(err.forbidden(messages.directInsertDisabled));
    }
  }

  const fields = await listFields(tableId, false, client);
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const hasRetryGeneratedId = fields.some(generatedIdRequiresRetry);
  const maxAttempts = hasRetryGeneratedId ? 10 : 1;
  let row: DbRow | undefined;
  let id = "";
  let validated: Result<Record<string, unknown>> | null = null;
  let split: { data: Record<string, unknown>; relations: Map<string, string[]> } | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    validated = await validateForCreate(tableId, payload, {
      actorId,
      dateConfig: opts.dateConfig,
      client,
      fields,
      locale: opts.locale,
    });
    if (!validated.ok) return validated;

    split = splitRelationsFromData(validated.data, fields);
    const recordData = split.data;
    const preflight = await preflightRelationTargets(split.relations, fieldsById, client, opts.viewer, opts.locale);
    if (!preflight.ok) return preflight;

    id = Bun.randomUUIDv7();
    const changedFieldIds = Object.keys(validated.data);
    const eventPayload = {
      v: 1,
      type: "record.created",
      version: 1,
      changedFieldIds,
      actorId,
    };
    if (hasRetryGeneratedId) await client`SAVEPOINT grids_generated_id_insert`;
    try {
      const rows = await insertWithShortIdForDb(
        client,
        "idx_grids_records_short_id",
        (attempt, shortId) => attempt<DbRow[]>`
          INSERT INTO grids.records (id, short_id, table_id, data, version, created_by, updated_by)
          VALUES (
            ${id}::uuid,
            ${shortId},
            ${tableId}::uuid,
            ${recordData}::jsonb,
            1,
            ${actorId}::uuid,
            ${actorId}::uuid
          )
          RETURNING *, grids.enqueue_record_event(${tableId}::uuid, ${id}::uuid, ${eventPayload}::jsonb)::text AS outbox_id
        `,
      );
      row = rows[0];
      if (hasRetryGeneratedId) await client`RELEASE SAVEPOINT grids_generated_id_insert`;
      break;
    } catch (e) {
      if (hasRetryGeneratedId) {
        await client`ROLLBACK TO SAVEPOINT grids_generated_id_insert`;
        await client`RELEASE SAVEPOINT grids_generated_id_insert`;
        if (isGeneratedIdUniqueCollision(e, fields)) continue;
      }
      throw e;
    }
  }
  if (!row && hasRetryGeneratedId) return fail(err.conflict(messages.generatedIdFailed));
  if (!row) throw new Error("insert returned no row");
  if (!validated?.ok || !split) throw new Error("record create validation state missing");

  await bindFieldNumberAllocations(
    client,
    id,
    fields.flatMap((field) =>
      field.type === "id" && typeof validated.data[field.id] === "string"
        ? [{ fieldId: field.id, renderedValue: validated.data[field.id] as string }]
        : [],
    ),
  );

  for (const [fieldId, toIds] of split.relations) {
    await writeRecordLinks(id, fieldId, toIds, client);
  }

  await captureRecordRevision(client, {
    tableId,
    recordId: id,
    action: "created",
    changedFieldIds: Object.keys(validated.data),
    actorId,
    schemaFields: fields,
  });

  await captureRecordEventSnapshot(client, {
    snapshotId: row.outbox_id as string,
    tableId,
    recordId: id,
    eventType: "record.created",
  });

  await logAudit(
    {
      tableId,
      recordId: id,
      userId: actorId,
      action: "created",
      diff: Object.fromEntries(Object.entries(validated.data).map(([k, v]) => [k, { old: null, new: v }])),
    },
    client,
  );
  const changedFieldIds = Object.keys(validated.data);
  const outboxId = row.outbox_id as string;

  const record = mapRecordRow(row);
  for (const [fieldId, toIds] of split.relations) {
    record.data[fieldId] = toIds;
  }
  enrichRecordsWithFormulas([record], fields, { dateConfig: opts.dateConfig });

  return ok({ record, changedFieldIds, outboxId });
};

export const create = async (
  tableId: string,
  payload: Record<string, unknown>,
  actorId: string | null,
  origin: MutationOrigin,
  opts: {
    includeRelations?: boolean;
    viewer?: ExpansionViewer;
    dateConfig?: DateContext;
    locale?: string;
  } = {},
): Promise<Result<GridRecord>> => {
  const created = await sql
    .begin((tx) =>
      createInTransaction(tx, tableId, payload, actorId, origin, {
        dateConfig: opts.dateConfig,
        viewer: opts.viewer,
        locale: opts.locale,
      }),
    )
    .catch(async (error: unknown) => {
      const conflict = recordUniqueConflict<CreateRecordInTransactionResult>(error, await listFields(tableId), opts.locale);
      if (conflict) return conflict;
      throw error;
    });
  if (!created.ok) return created;
  const record = await get(tableId, created.data.record.id, opts);
  if (!record) return fail(err.notFound(getGridsCrudMessages(opts.locale).record));
  notifyRecordEventOutbox(created.data.outboxId);
  return ok(record);
};

export const createMany = async (
  tableId: string,
  payloads: Record<string, unknown>[],
  actorId: string | null,
  origin: MutationOrigin,
  opts: {
    includeRelations?: boolean;
    viewer?: ExpansionViewer;
    dateConfig?: DateContext;
    locale?: string;
  } = {},
): Promise<Result<GridRecord[]>> => {
  if (payloads.length === 0) return ok([]);
  type RollbackError = Error & { result: Result<CreateRecordInTransactionResult[]> };
  const created = await sql
    .begin(async (tx) => {
      const results: CreateRecordInTransactionResult[] = [];
      for (const payload of payloads) {
        const result = await createInTransaction(tx, tableId, payload, actorId, origin, {
          dateConfig: opts.dateConfig,
          viewer: opts.viewer,
          locale: opts.locale,
        });
        if (!result.ok) {
          const rollback = new Error(result.error.message) as RollbackError;
          rollback.result = result as Result<CreateRecordInTransactionResult[]>;
          throw rollback;
        }
        results.push(result.data);
      }
      return ok(results);
    })
    .catch(async (error: unknown) => {
      if (error && typeof error === "object" && "result" in error) return (error as RollbackError).result;
      const conflict = recordUniqueConflict<CreateRecordInTransactionResult[]>(error, await listFields(tableId), opts.locale);
      if (conflict) return conflict;
      throw error;
    });
  if (!created.ok) return created;

  const reader = await createReader(tableId, opts);
  const records = await reader.getMany(created.data.map((item) => item.record.id));
  if (records.length !== created.data.length) return fail(err.notFound(getGridsCrudMessages(opts.locale).record));
  for (const item of created.data) notifyRecordEventOutbox(item.outboxId);
  return ok(records);
};

type UpdateRecordInTransactionResult = {
  record: GridRecord;
  outboxId: string | null;
};

export const updateInTransaction = async (
  client: SqlClient,
  tableId: string,
  recordId: string,
  payload: Record<string, unknown>,
  actorId: string | null,
  origin: MutationOrigin,
  ifMatchVersion?: number,
  opts: {
    dateConfig?: DateContext;
    audit?: RecordMutationAudit;
    viewer?: ExpansionViewer;
    locale?: string;
  } = {},
): Promise<Result<UpdateRecordInTransactionResult>> => {
  const messages = getGridsCrudMessages(opts.locale);
  const writable = await requireStoredTableWritable(tableId, client, opts.locale);
  if (!writable.ok) return writable;
  const allowed = await assertMutationAllowed(client, tableId, origin, opts.locale);
  if (!allowed.ok) return allowed;
  await lockDurableHistoryMutationBoundary(client, tableId);
  const fields = await listFields(tableId, false, client);
  const existing = await loadStoredRecordForUpdate(client, tableId, recordId, fields);
  if (!existing || existing.deletedAt) return fail(err.notFound(messages.record));
  if (ifMatchVersion !== undefined && ifMatchVersion !== existing.version) {
    return fail(recordVersionConflict(opts.locale));
  }

  const validated = await validateForUpdate(tableId, payload, fields, actorId, opts.locale);
  if (!validated.ok) return validated;

  const fieldsIncludingDeleted = await listFields(tableId, true, client);
  const split = splitRelationsFromData(validated.data, fields);

  // Pre-flight relation-target existence check (same reasoning as create).
  // Batched per target table; runs outside the write transaction.
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const preflight = await preflightRelationTargets(split.relations, fieldsById, client, opts.viewer, opts.locale);
  if (!preflight.ok) return preflight;

  // Merge: existing JSONB data + only the validated NON-RELATION fields.
  // Relations are managed exclusively via record_links — they MUST NOT
  // re-enter the JSONB blob (otherwise the hydration step on read
  // would have to special-case "JSONB takes precedence" semantics).
  const merged = buildPersistedUpdateData(existing.data, split.data, fieldsIncludingDeleted);

  // Build the diff up front so we can pass it into the transaction.
  const diff = buildRecordDiff(existing.data, validated.data);
  if (Object.keys(diff).length === 0) {
    const mutable = await assertRecordMutable(client, tableId, recordId, opts.locale);
    return mutable.ok ? ok({ record: existing, outboxId: null }) : mutable;
  }
  const auditPolicy = await loadTableAuditPolicy(client, tableId, opts.locale);
  if (!auditPolicy.ok) return auditPolicy;
  const auditContext = buildRecordAuditContext(auditPolicy.data, "update", Object.keys(diff), opts.audit, opts.locale);
  if (!auditContext.ok) return auditContext;
  await prepareRecordMutation(client, tableId, recordId);
  const mutable = await assertRecordMutable(client, tableId, recordId, opts.locale);
  if (!mutable.ok) return mutable;
  const eventPayload = {
    v: 1,
    type: "record.updated",
    version: existing.version + 1,
    changedFieldIds: Object.keys(diff),
    actorId,
  };

  const [row] = await client<DbRow[]>`
      UPDATE grids.records
      SET data = ${merged}::jsonb,
          version = version + 1,
          updated_by = ${actorId}::uuid,
          updated_at = now()
      WHERE id = ${recordId}::uuid
        AND table_id = ${tableId}::uuid
        AND deleted_at IS NULL
        AND version = ${existing.version}
      RETURNING *, grids.enqueue_record_event(${tableId}::uuid, ${recordId}::uuid, ${eventPayload}::jsonb)::text AS outbox_id
    `;
  if (!row) return fail(recordVersionConflict(opts.locale));

  await supersedePendingFinalizationRequest(client, tableId, recordId, actorId);

  for (const [fieldId, toIds] of split.relations) {
    await writeRecordLinks(recordId, fieldId, toIds, client);
  }
  await captureRecordRevision(client, {
    tableId,
    recordId,
    action: "updated",
    changedFieldIds: Object.keys(diff),
    actorId,
    schemaFields: fields,
  });
  await captureRecordEventSnapshot(client, {
    snapshotId: row.outbox_id as string,
    tableId,
    recordId,
    eventType: "record.updated",
  });
  if (Object.keys(diff).length > 0) {
    await logAudit({ tableId, recordId, userId: actorId, action: "updated", diff, context: auditContext.data }, client);
  }
  const record = mapRecordRow(row);
  for (const [fieldId, toIds] of split.relations) record.data[fieldId] = toIds;
  enrichRecordsWithFormulas([record], fields, { dateConfig: opts.dateConfig });
  return ok({ record, outboxId: row.outbox_id as string });
};

export const update = async (
  tableId: string,
  recordId: string,
  payload: Record<string, unknown>,
  actorId: string | null,
  origin: MutationOrigin,
  ifMatchVersion?: number,
  opts: {
    includeRelations?: boolean;
    viewer?: ExpansionViewer;
    dateConfig?: DateContext;
    audit?: RecordMutationAudit;
    locale?: string;
  } = {},
): Promise<Result<GridRecord>> => {
  const fields = await listFields(tableId);
  const updated = await sql
    .begin((tx) =>
      updateInTransaction(tx, tableId, recordId, payload, actorId, origin, ifMatchVersion, {
        dateConfig: opts.dateConfig,
        audit: opts.audit,
        viewer: opts.viewer,
        locale: opts.locale,
      }),
    )
    .catch((error: unknown) => {
      const conflict = recordUniqueConflict<UpdateRecordInTransactionResult>(error, fields, opts.locale);
      if (conflict) return conflict;
      throw error;
    });
  if (!updated.ok) return updated;

  const record = await get(tableId, recordId, opts);
  if (!record) return fail(err.notFound(getGridsCrudMessages(opts.locale).record));
  if (updated.data.outboxId) notifyRecordEventOutbox(updated.data.outboxId);
  return ok(record);
};

export const softDelete = async (
  tableId: string,
  recordId: string,
  actorId: string | null,
  origin: MutationOrigin,
  audit?: RecordMutationAudit,
  locale?: string,
): Promise<Result<void>> => {
  const messages = getGridsCrudMessages(locale);
  const writable = await requireStoredTableWritable(tableId, sql, locale);
  if (!writable.ok) return writable;
  const existing = await get(tableId, recordId);
  if (!existing || existing.deletedAt) return fail(err.notFound(messages.record));
  const eventPayload = {
    v: 1,
    type: "record.deleted",
    version: existing.version,
    changedFieldIds: Object.keys(existing.data),
    actorId,
  };
  const deleted = await sql
    .begin(async (tx): Promise<Result<string>> => {
      const allowed = await assertMutationAllowed(tx, tableId, origin, locale);
      if (!allowed.ok) return allowed;
      await lockDurableHistoryMutationBoundary(tx, tableId);
      const auditPolicy = await loadTableAuditPolicy(tx, tableId, locale);
      if (!auditPolicy.ok) return auditPolicy;
      const auditContext = buildRecordAuditContext(auditPolicy.data, "delete", [], audit, locale);
      if (!auditContext.ok) return auditContext;
      await prepareRecordMutation(tx, tableId, recordId);
      const mutable = await assertRecordMutable(tx, tableId, recordId, locale);
      if (!mutable.ok) return mutable;
      const [row] = await tx<Array<{ outbox_id: string }>>`
        UPDATE grids.records
        SET deleted_at = now(), updated_by = ${actorId}::uuid, updated_at = now()
        WHERE id = ${recordId}::uuid
          AND table_id = ${tableId}::uuid
          AND deleted_at IS NULL
          AND version = ${existing.version}
        RETURNING grids.enqueue_record_event(${tableId}::uuid, ${recordId}::uuid, ${eventPayload}::jsonb)::text AS outbox_id
      `;
      if (!row) {
        const conflict = new Error("VERSION_CONFLICT") as Error & { __versionConflict: true };
        conflict.__versionConflict = true;
        throw conflict;
      }
      await supersedePendingFinalizationRequest(tx, tableId, recordId, actorId, "The Record was moved to trash.");
      await captureRecordEventSnapshot(tx, {
        snapshotId: row.outbox_id,
        tableId,
        recordId,
        eventType: "record.deleted",
      });
      await captureRecordRevision(tx, {
        tableId,
        recordId,
        action: "deleted",
        changedFieldIds: Object.keys(existing.data),
        actorId,
      });
      await logAudit({ tableId, recordId, userId: actorId, action: "deleted", context: auditContext.data }, tx);
      return ok(row.outbox_id);
    })
    .catch((error: unknown) => {
      if ((error as { __versionConflict?: true })?.__versionConflict) return fail(recordVersionConflict(locale));
      throw error;
    });
  if (!deleted.ok) return deleted;
  notifyRecordEventOutbox(deleted.data);
  return ok();
};

export const restore = async (
  tableId: string,
  recordId: string,
  actorId: string | null,
  origin: MutationOrigin,
  audit?: RecordMutationAudit,
  locale?: string,
): Promise<Result<void>> => {
  const messages = getGridsCrudMessages(locale);
  const fields = await listFields(tableId);
  const eventPayload = {
    v: 1,
    type: "record.restored",
    version: null,
    changedFieldIds: [],
    actorId,
  };
  const restored = await sql
    .begin(async (tx): Promise<Result<string>> => {
      const writable = await requireStoredTableWritable(tableId, tx, locale);
      if (!writable.ok) return writable;
      const allowed = await assertMutationAllowed(tx, tableId, origin, locale);
      if (!allowed.ok) return allowed;
      await lockDurableHistoryMutationBoundary(tx, tableId);
      const auditPolicy = await loadTableAuditPolicy(tx, tableId, locale);
      if (!auditPolicy.ok) return auditPolicy;
      const auditContext = buildRecordAuditContext(auditPolicy.data, "restore", [], audit, locale);
      if (!auditContext.ok) return auditContext;
      await prepareRecordMutation(tx, tableId, recordId);
      const mutable = await assertRecordMutable(tx, tableId, recordId, locale);
      if (!mutable.ok) return mutable;
      const [row] = await tx<Array<{ outbox_id: string }>>`
        UPDATE grids.records
        SET deleted_at = NULL, updated_by = ${actorId}::uuid, updated_at = now()
        WHERE id = ${recordId}::uuid AND table_id = ${tableId}::uuid AND deleted_at IS NOT NULL
        RETURNING grids.enqueue_record_event(${tableId}::uuid, ${recordId}::uuid, ${eventPayload}::jsonb)::text AS outbox_id
      `;
      if (!row) return fail(err.notFound(messages.record));
      await supersedePendingFinalizationRequest(tx, tableId, recordId, actorId, "The Record was restored from trash.");
      await captureRecordEventSnapshot(tx, {
        snapshotId: row.outbox_id,
        tableId,
        recordId,
        eventType: "record.restored",
      });
      await captureRecordRevision(tx, { tableId, recordId, action: "restored", actorId });
      await logAudit({ tableId, recordId, userId: actorId, action: "restored", context: auditContext.data }, tx);
      return ok(row.outbox_id);
    })
    .catch((error: unknown) => {
      const conflict = recordUniqueConflict<string>(error, fields, locale);
      if (conflict) return conflict;
      throw error;
    });
  if (!restored.ok) return restored;
  notifyRecordEventOutbox(restored.data);
  return ok();
};
