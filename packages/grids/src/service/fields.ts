import { err, fail, ok, type Result } from "@k2b/stdlib";
import { isUniqueViolation, logger, toPgUuidArray } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import { FieldColumnSpecSchema, RecordDisplayConfigSchema, ViewUiSettingsSchema } from "../contracts";
import { isKnownFieldType } from "../field-types";
import { groupedColumnFieldId } from "../presentation-ids";
import { normalizeRefKey } from "../ref-syntax";
import { logAudit, type SqlClient } from "./audit";
import { buildFormulaSqlProjections } from "./computed-projections";
import { getGridsCrudMessages } from "./crud-messages";
import { degradeForTableSchemaChange, lockFederatedSchemaTables, refreshForTableSchemaChange } from "./federated-tables";
import { getFieldDependents, hasBlockingDependents } from "./field-dependents";
import {
  dropFieldIndex,
  dropFieldUniqueIndex,
  ensureFieldIndex,
  ensureFieldUniqueIndex,
  findUniqueConflicts,
  isUniqueable,
} from "./field-indexes";
import { get, listByTable, mapFieldRow } from "./field-read";
import { cleanupPreparedUniqueIndex } from "./field-unique-index-lifecycle";
import { materializeFieldDefault, validateDefaultValue, validateFieldConfig, validateLinkOrComputedConfig } from "./field-validation";
import { emitTableMetadataEvent } from "./metadata-events";
import { namedResourceConflict, writeNamedResource } from "./named-resource-conflict";
import { numberSeriesFormatForField, provisionFieldNumberSeries, setNumberSeriesArchived, syncNumberSeriesFormat } from "./number-series";
import { rewriteFieldNameReferences } from "./reference-renames";
import { insertWithShortId } from "./short-id";
import type { CreateFieldInput, Field, UpdateFieldInput } from "./types";

type DbRow = Record<string, unknown>;

const log = logger("grids:fields");

const withoutFieldDisplayReference = (raw: unknown, fieldId: string) => {
  const parsed = RecordDisplayConfigSchema.safeParse(raw ?? { mode: "table" });
  if (!parsed.success) return raw;
  const config = parsed.data;
  return {
    ...config,
    ...(config.cards
      ? {
          cards: {
            ...config.cards,
            ...(config.cards.imageFieldId === fieldId ? { imageFieldId: null } : {}),
            ...(config.cards.fieldIds ? { fieldIds: config.cards.fieldIds.filter((id) => id !== fieldId) } : {}),
          },
        }
      : {}),
    ...(config.calendar?.dateFieldId === fieldId ? { calendar: { ...config.calendar, dateFieldId: null } } : {}),
  };
};

const withoutFieldViewUiReference = (raw: unknown, fieldId: string) => {
  const parsed = ViewUiSettingsSchema.safeParse(raw ?? {});
  if (!parsed.success) return raw;
  return {
    ...parsed.data,
    columns: parsed.data.columns?.filter((column) => !("fieldId" in column) || column.fieldId !== fieldId),
    displayConfig: withoutFieldDisplayReference(parsed.data.displayConfig, fieldId),
    groupedColumnOrder: parsed.data.groupedColumnOrder?.filter((key) => groupedColumnFieldId(key) !== fieldId),
    hiddenGroupedColumns: parsed.data.hiddenGroupedColumns?.filter((key) => groupedColumnFieldId(key) !== fieldId),
  };
};

type FieldUpdateState = {
  name: string;
  description: string | null;
  icon: string | null;
  config: Record<string, unknown>;
  position: number;
  required: boolean;
  presentable: boolean;
  hideInTable: boolean;
  defaultValue: unknown;
  indexed: boolean;
  uniqueConstraint: boolean;
};

const fieldUpdateState = (field: Field): FieldUpdateState => ({
  name: field.name,
  description: field.description,
  icon: field.icon ?? null,
  config: field.config,
  position: field.position,
  required: field.required,
  presentable: field.presentable,
  hideInTable: field.hideInTable,
  defaultValue: field.defaultValue,
  indexed: field.indexed,
  uniqueConstraint: field.uniqueConstraint,
});

const updatedNullableText = (value: string | null | undefined, current: string | null): string | null => {
  if (value === undefined) return current;
  return typeof value === "string" ? value.trim() || null : null;
};

const ensureUniqueFieldName = async (
  tableId: string,
  name: string,
  exceptFieldId: string | null = null,
  locale?: string,
): Promise<Result<void>> => {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM grids.fields
    WHERE table_id = ${tableId}::uuid
      AND deleted_at IS NULL
      AND lower(trim(name)) = ${normalizeRefKey(name)}
      AND (${exceptFieldId}::uuid IS NULL OR id <> ${exceptFieldId}::uuid)
  `;
  return (row?.count ?? 0) === 0 ? ok() : fail(err.conflict(getGridsCrudMessages(locale).fieldNameUnique));
};

const validateCombinedCanonicalField = async (tableKind: string, candidate: Field, locale?: string): Promise<Result<void>> => {
  const messages = getGridsCrudMessages(locale);
  if (
    candidate.type === "html_template" &&
    (candidate.required || candidate.defaultValue !== null || candidate.indexed || candidate.uniqueConstraint || candidate.presentable)
  ) {
    return fail(err.badInput(messages.htmlFieldConstraints));
  }
  if (tableKind !== "federated") return ok();
  if (candidate.type === "html_template") {
    return fail(err.badInput(messages.combinedHtmlUnsupported));
  }
  if (candidate.type === "lookup" || candidate.type === "rollup") {
    return fail(err.badInput(messages.combinedComputedUnsupported({ type: candidate.type })));
  }
  if (candidate.type !== "formula") return ok();
  const fields = await listByTable(candidate.tableId);
  const prospective = [...fields.filter((field) => field.id !== candidate.id), candidate];
  const compiled = buildFormulaSqlProjections(prospective).some((projection) => projection.fieldId === candidate.id);
  return compiled ? ok() : fail(err.badInput(messages.combinedFormulaSql));
};

type FieldCreateState = {
  candidate: Field;
  tableKind: string;
  requestedPosition: number | null;
  defaultValueJsonb: string | null;
};

type ValidatedFieldCreate = {
  name: string;
  config: Record<string, unknown>;
  defaultValue: unknown;
};

const requireFinalizationForIdConfig = async (
  client: SqlClient,
  tableId: string,
  type: string,
  config: Record<string, unknown>,
  locale?: string,
): Promise<Result<void>> => {
  if (type !== "id" || config.assignment !== "finalization") return ok();
  const rows = await client`
    SELECT table_id FROM grids.table_finalization_activations
    WHERE table_id = ${tableId}::uuid FOR SHARE
  `;
  return rows.length > 0 ? ok() : fail(err.badInput(getGridsCrudMessages(locale).finalizationAssignmentUnavailable));
};

const validateFieldCreateIdentity = async (input: CreateFieldInput, locale?: string): Promise<Result<string>> => {
  const messages = getGridsCrudMessages(locale);
  const name = input.name.trim();
  if (name.length === 0) return fail(err.badInput(messages.nameRequired));
  if (!isKnownFieldType(input.type)) return fail(err.badInput(messages.unknownFieldType({ type: input.type })));
  const uniqueName = await ensureUniqueFieldName(input.tableId, name, null, locale);
  if (!uniqueName.ok) return uniqueName;
  return ok(name);
};

const validateFieldCreateValues = async (input: CreateFieldInput, name: string, locale?: string): Promise<Result<ValidatedFieldCreate>> => {
  const configResult = validateFieldConfig(input.type, input.config ?? {}, locale);
  if (!configResult.ok) return configResult;
  const config = configResult.data as Record<string, unknown>;
  if (input.type === "id" && config.assignment === "finalization") {
    const [enabled] = await sql<{ enabled: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM grids.table_finalization_activations WHERE table_id = ${input.tableId}::uuid
      ) AS enabled
    `;
    if (!enabled?.enabled) return fail(err.badInput(getGridsCrudMessages(locale).finalizationAssignmentUnavailable));
  }
  const linkResult = await validateLinkOrComputedConfig(input.type, config, input.tableId, locale);
  if (!linkResult.ok) return linkResult;
  const defaultResult = validateDefaultValue(input.type, config, input.defaultValue, locale);
  if (!defaultResult.ok) return defaultResult;

  return ok({ name, config, defaultValue: defaultResult.data });
};

const loadFieldCreateTableKind = async (input: CreateFieldInput, locale?: string): Promise<Result<string>> => {
  const [parentTable] = await sql<{ kind: string }[]>`
    SELECT kind FROM grids.tables WHERE id = ${input.tableId}::uuid AND deleted_at IS NULL
  `;
  if (!parentTable) return fail(err.notFound(getGridsCrudMessages(locale).table));
  const hasStoredConstraints = input.required || input.defaultValue !== undefined || input.indexed || input.uniqueConstraint;
  if (parentTable.kind === "federated" && hasStoredConstraints) {
    return fail(err.badInput(getGridsCrudMessages(locale).combinedStoredConstraints));
  }
  return ok(parentTable.kind);
};

const buildFieldCreateCandidate = (input: CreateFieldInput, validated: ValidatedFieldCreate, tableKind: string): Field => {
  const now = new Date().toISOString();
  return {
    id: Bun.randomUUIDv7(),
    shortId: "pending",
    tableId: input.tableId,
    name: validated.name,
    description: input.description?.trim() || null,
    icon: input.icon?.trim() || null,
    type: input.type,
    config: validated.config,
    position: input.position ?? 0,
    required: input.required ?? false,
    presentable: input.presentable ?? false,
    hideInTable: input.hideInTable ?? false,
    defaultValue: validated.defaultValue ?? null,
    indexed: input.indexed ?? false,
    uniqueConstraint: tableKind === "federated" ? false : input.type === "id" ? true : (input.uniqueConstraint ?? false),
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
};

const prepareFieldCreate = async (input: CreateFieldInput, locale?: string): Promise<Result<FieldCreateState>> => {
  const name = await validateFieldCreateIdentity(input, locale);
  if (!name.ok) return name;
  const tableKind = await loadFieldCreateTableKind(input, locale);
  if (!tableKind.ok) return tableKind;
  const validated = await validateFieldCreateValues(input, name.data, locale);
  if (!validated.ok) return validated;
  const candidate = buildFieldCreateCandidate(input, validated.data, tableKind.data);
  const canonicalResult = await validateCombinedCanonicalField(tableKind.data, candidate, locale);
  if (!canonicalResult.ok) return canonicalResult;

  return ok({
    candidate,
    tableKind: tableKind.data,
    requestedPosition: input.position ?? null,
    defaultValueJsonb:
      validated.data.defaultValue === undefined || validated.data.defaultValue === null
        ? null
        : JSON.stringify(validated.data.defaultValue),
  });
};

const insertPreparedField = async (state: FieldCreateState, actorId: string | null, locale?: string): Promise<Result<Field>> =>
  sql.begin(async (tx): Promise<Result<Field>> => {
    const field = state.candidate;
    const finalization = await requireFinalizationForIdConfig(tx, field.tableId, field.type, field.config, locale);
    if (!finalization.ok) return finalization;
    if (state.tableKind === "federated") await degradeForTableSchemaChange(field.tableId, actorId, tx);
    const created = await writeNamedResource(
      () =>
        insertWithShortId<DbRow>(
          (shortId) =>
            tx.savepoint(async (sp) => {
              const [row] = await sp<DbRow[]>`
                INSERT INTO grids.fields (
                  id, short_id, table_id, name, description, icon, type, config, position, required,
                  presentable, hide_in_table, default_value, indexed, unique_constraint
                )
                VALUES (
                  ${field.id}::uuid, ${shortId}, ${field.tableId}::uuid, ${field.name}, ${field.description}::text,
                  ${field.icon}::text, ${field.type}, ${field.config}::jsonb,
                  COALESCE(${state.requestedPosition}::int, (SELECT COALESCE(MAX(position) + 1, 0) FROM grids.fields WHERE table_id = ${field.tableId}::uuid AND deleted_at IS NULL)),
                  ${field.required}, ${field.presentable}, ${field.hideInTable}, ${state.defaultValueJsonb}::jsonb,
                  ${field.indexed}, ${field.uniqueConstraint}
                )
                RETURNING *
              `;
              if (!row) throw new Error("insert returned no row");
              return row;
            }),
          "idx_grids_fields_short_id",
        ),
      "idx_grids_fields_live_name",
      getGridsCrudMessages(locale).fieldNameUnique,
    );
    if (!created.ok) return created;
    const inserted = mapFieldRow(created.data);
    if (inserted.type === "id") await provisionFieldNumberSeries(tx, inserted.id, inserted.config);
    await logAudit(
      {
        tableId: inserted.tableId,
        userId: actorId,
        action: "created",
        diff: { field: { old: null, new: { id: inserted.id, name: inserted.name, type: inserted.type } } },
      },
      tx,
    );
    return ok(inserted);
  });

const prepareCreateUniqueIndex = async (field: Field, locale?: string): Promise<Result<boolean>> => {
  if (!field.uniqueConstraint || !isUniqueable(field.type)) return ok(false);
  try {
    await ensureFieldUniqueIndex(field.id, field.type, field.tableId);
    return ok(true);
  } catch (error) {
    return fail(err.internal(getGridsCrudMessages(locale).fieldUniqueIndexBuildFailed({ detail: (error as Error).message })));
  }
};

const insertWithUniqueIndexCleanup = async (
  state: FieldCreateState,
  actorId: string | null,
  uniqueIndexCreated: boolean,
  locale?: string,
): Promise<Result<Field>> => {
  try {
    const inserted = await insertPreparedField(state, actorId, locale);
    if (inserted.ok || !uniqueIndexCreated) return inserted;
    const cleanup = await cleanupPreparedUniqueIndex(state.candidate.id);
    return cleanup.ok ? inserted : fail(cleanup.error);
  } catch (error) {
    if (!uniqueIndexCreated) throw error;
    const cleanup = await cleanupPreparedUniqueIndex(state.candidate.id);
    if (!cleanup.ok) throw new AggregateError([error, cleanup.error], cleanup.error.message);
    throw error;
  }
};

export const create = async (input: CreateFieldInput, actorId: string | null, locale?: string): Promise<Result<Field>> => {
  const prepared = await prepareFieldCreate(input, locale);
  if (!prepared.ok) return prepared;
  const uniqueIndex = await prepareCreateUniqueIndex(prepared.data.candidate, locale);
  if (!uniqueIndex.ok) return uniqueIndex;
  const inserted = await insertWithUniqueIndexCleanup(prepared.data, actorId, uniqueIndex.data, locale);
  if (!inserted.ok) return inserted;
  const field = inserted.data;

  if (field.indexed) {
    void ensureFieldIndex(field.id, field.type, field.tableId, field.config);
  }

  await emitTableMetadataEvent(input.tableId, {
    type: "field.created",
    resource: { kind: "field", id: field.id, tableId: input.tableId },
    actorId,
  });
  if (prepared.data.tableKind === "federated") await refreshForTableSchemaChange(input.tableId, actorId);
  return ok(field);
};

const validateFieldUpdate = async (
  existing: Field,
  input: UpdateFieldInput,
  tableKind: string,
  locale?: string,
): Promise<Result<FieldUpdateState>> => {
  const messages = getGridsCrudMessages(locale);
  const name = input.name?.trim();
  if (name !== undefined && name.length === 0) return fail(err.badInput(messages.nameEmpty));

  const rawConfig = input.config !== undefined ? input.config : existing.config;
  const cfgValidation = validateFieldConfig(existing.type, rawConfig, locale);
  if (!cfgValidation.ok) return cfgValidation;
  const config = cfgValidation.data as Record<string, unknown>;
  if (existing.type === "id" && config.assignment === "finalization") {
    const [enabled] = await sql<{ enabled: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM grids.table_finalization_activations WHERE table_id = ${existing.tableId}::uuid
      ) AS enabled
    `;
    if (!enabled?.enabled) return fail(err.badInput(messages.finalizationAssignmentUnavailable));
  }
  // Same-base + cross-table consistency on every update path. Important:
  // the user can't change `tableId` after creation, so the source-table
  // scope is stable, but config keys (targetTableId / relationFieldId /
  // targetFieldId) ARE editable — re-validate.
  const linkValidation = await validateLinkOrComputedConfig(existing.type, config as Record<string, unknown>, existing.tableId, locale);
  if (!linkValidation.ok) return linkValidation;

  const rawDefaultValue = tableKind === "federated" ? null : input.defaultValue !== undefined ? input.defaultValue : existing.defaultValue;
  const defaultValid = validateDefaultValue(existing.type, config as Record<string, unknown>, rawDefaultValue, locale);
  if (!defaultValid.ok) return defaultValid;

  return ok({
    name: name ?? existing.name,
    // Empty string in description input → store null (clears the helper).
    description: updatedNullableText(input.description, existing.description),
    icon: updatedNullableText(input.icon, existing.icon ?? null),
    config,
    position: input.position ?? existing.position,
    required: tableKind === "federated" ? false : (input.required ?? existing.required),
    presentable: input.presentable ?? existing.presentable,
    hideInTable: input.hideInTable ?? existing.hideInTable,
    defaultValue: defaultValid.data,
    indexed: tableKind === "federated" ? false : (input.indexed ?? existing.indexed),
    uniqueConstraint:
      tableKind === "federated" ? false : existing.type === "id" ? true : (input.uniqueConstraint ?? existing.uniqueConstraint),
  });
};

const ensureUniqueToggleAllowed = async (
  fieldId: string,
  existing: Field,
  input: UpdateFieldInput,
  locale?: string,
): Promise<Result<void>> => {
  const messages = getGridsCrudMessages(locale);
  // Pre-flight conflict check so users get a clean 409 before the unique
  // index build could fail with a generic Postgres duplicate-key error.
  if (input.uniqueConstraint === true && !existing.uniqueConstraint) {
    if (!isUniqueable(existing.type)) {
      return fail(err.badInput(messages.uniqueConstraintUnsupported({ type: existing.type })));
    }
    const conflicts = await findUniqueConflicts(fieldId, existing.tableId);
    if (conflicts.length > 0) {
      return fail(
        err.conflict(messages.duplicateFieldValues({ values: conflicts.slice(0, 5).join(", "), more: Math.max(0, conflicts.length - 5) })),
      );
    }
  }
  return ok();
};

const persistFieldUpdate = async (id: string, next: FieldUpdateState, client: SqlClient = sql, locale?: string): Promise<Result<Field>> => {
  // Same primitive-to-JSONB stringify dance as create.
  const nextDefaultValueJsonb = next.defaultValue === undefined || next.defaultValue === null ? null : JSON.stringify(next.defaultValue);
  const [row] = await client<DbRow[]>`
    UPDATE grids.fields
    SET name = ${next.name},
        description = ${next.description}::text,
        icon = ${next.icon}::text,
        config = ${next.config}::jsonb,
        position = ${next.position},
        required = ${next.required},
        presentable = ${next.presentable},
        hide_in_table = ${next.hideInTable},
        default_value = ${nextDefaultValueJsonb}::jsonb,
        indexed = ${next.indexed},
        unique_constraint = ${next.uniqueConstraint},
        updated_at = now()
    WHERE id = ${id}::uuid
    RETURNING *
  `;
  if (!row) return fail(err.internal(getGridsCrudMessages(locale).updateFailed));
  return ok(mapFieldRow(row));
};

const logFieldUpdateDiff = async (
  existing: Field,
  next: FieldUpdateState,
  actorId: string | null,
  client: SqlClient = sql,
): Promise<void> => {
  const diff: Record<string, { old: unknown; new: unknown }> = {};
  const jsonEqual = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
  if (next.name !== existing.name) diff.name = { old: existing.name, new: next.name };
  if (next.description !== existing.description) diff.description = { old: existing.description, new: next.description };
  if (next.icon !== existing.icon) diff.icon = { old: existing.icon, new: next.icon };
  if (!jsonEqual(next.config, existing.config)) diff.config = { old: existing.config, new: next.config };
  if (next.position !== existing.position) diff.position = { old: existing.position, new: next.position };
  if (next.required !== existing.required) diff.required = { old: existing.required, new: next.required };
  if (next.presentable !== existing.presentable) diff.presentable = { old: existing.presentable, new: next.presentable };
  if (next.hideInTable !== existing.hideInTable) diff.hideInTable = { old: existing.hideInTable, new: next.hideInTable };
  if (!jsonEqual(next.defaultValue, existing.defaultValue)) {
    diff.defaultValue = { old: existing.defaultValue, new: next.defaultValue };
  }
  if (next.indexed !== existing.indexed) diff.indexed = { old: existing.indexed, new: next.indexed };
  if (next.uniqueConstraint !== existing.uniqueConstraint) {
    diff.uniqueConstraint = { old: existing.uniqueConstraint, new: next.uniqueConstraint };
  }
  if (Object.keys(diff).length > 0) {
    await logAudit({ tableId: existing.tableId, userId: actorId, action: "updated", diff }, client);
  }
};

const compensateUniqueConstraintDisable = async (
  existing: Field,
  field: Field,
  actorId: string | null,
  locale?: string,
): Promise<Field | null> => {
  try {
    const restored = await sql.begin(async (tx) => {
      const restoredResult = await persistFieldUpdate(field.id, fieldUpdateState(existing), tx, locale);
      if (!restoredResult.ok) throw new Error(restoredResult.error.message);
      if (existing.type === "id") {
        await syncNumberSeriesFormat(
          tx,
          { kind: "field", id: existing.id },
          numberSeriesFormatForField(existing.config),
          (existing.config as { assignment?: "creation" | "finalization" }).assignment ?? "creation",
        );
      }
      await logFieldUpdateDiff(field, fieldUpdateState(existing), actorId, tx);
      if (field.name !== existing.name) {
        await rewriteFieldNameReferences({ tableId: field.tableId, oldName: field.name, newName: existing.name }, tx);
      }
      return restoredResult.data;
    });
    await emitTableMetadataEvent(field.tableId, {
      type: "field.updated",
      resource: { kind: "field", id: field.id, tableId: field.tableId },
      actorId,
    });
    return restored;
  } catch (error) {
    log.error("Failed to compensate unique-constraint disable", { fieldId: field.id, error: String(error) });
    return null;
  }
};

const syncFieldIndexes = async (existing: Field, field: Field, actorId: string | null, locale?: string): Promise<Result<Field>> => {
  // Unique-constraint enable is prepared before the row transaction. Only
  // disabling remains here. Resolve it before best-effort performance-index
  // work so compensation can restore the complete prior field state.
  if (existing.uniqueConstraint !== field.uniqueConstraint) {
    if (!field.uniqueConstraint) {
      try {
        await dropFieldUniqueIndex(field.id, { throwOnError: true });
      } catch {
        const compensated = await compensateUniqueConstraintDisable(existing, field, actorId, locale);
        return fail(
          err.internal(
            compensated
              ? getGridsCrudMessages(locale).fieldIndexDropRolledBack
              : getGridsCrudMessages(locale).fieldIndexDropCompensationFailed,
          ),
        );
      }
    }
  }
  const indexShapeChanged =
    field.indexed &&
    ((field.type === "select" &&
      (existing.config as { multiple?: boolean }).multiple !== (field.config as { multiple?: boolean }).multiple) ||
      (field.type === "date" &&
        (existing.config as { includeTime?: boolean }).includeTime !== (field.config as { includeTime?: boolean }).includeTime));
  // Toggle or rebuild performance indexes outside the row commit. Both calls
  // are idempotent and index DDL runs concurrently.
  if (existing.indexed !== field.indexed || indexShapeChanged) {
    if (field.indexed) void ensureFieldIndex(field.id, field.type, field.tableId, field.config);
    else void dropFieldIndex(field.id);
  }
  return ok(field);
};

export const update = async (id: string, input: UpdateFieldInput, actorId: string | null, locale?: string): Promise<Result<Field>> => {
  const messages = getGridsCrudMessages(locale);
  const existing = await get(id);
  if (!existing || existing.deletedAt) return fail(err.notFound(messages.field));

  const [parentTable] = await sql<{ kind: string }[]>`
    SELECT kind FROM grids.tables WHERE id = ${existing.tableId}::uuid AND deleted_at IS NULL
  `;
  if (!parentTable) return fail(err.notFound(messages.table));
  if (
    parentTable.kind === "federated" &&
    (input.required === true ||
      (input.defaultValue !== undefined && input.defaultValue !== null) ||
      input.indexed === true ||
      input.uniqueConstraint === true)
  ) {
    return fail(err.badInput(messages.combinedStoredConstraints));
  }

  const nextResult = await validateFieldUpdate(existing, input, parentTable.kind, locale);
  if (!nextResult.ok) return nextResult;
  const canonicalValidation = await validateCombinedCanonicalField(
    parentTable.kind,
    {
      ...existing,
      ...nextResult.data,
      defaultValue: nextResult.data.defaultValue ?? null,
    },
    locale,
  );
  if (!canonicalValidation.ok) return canonicalValidation;
  const uniqueName = await ensureUniqueFieldName(existing.tableId, nextResult.data.name, existing.id, locale);
  if (!uniqueName.ok) return uniqueName;

  const uniqueAllowed = await ensureUniqueToggleAllowed(id, existing, input, locale);
  if (!uniqueAllowed.ok) return uniqueAllowed;

  const uniqueIndexEnabled = !existing.uniqueConstraint && nextResult.data.uniqueConstraint;
  if (uniqueIndexEnabled) {
    try {
      // Prepare correctness-critical enforcement before changing metadata.
      await ensureFieldUniqueIndex(id, existing.type, existing.tableId);
    } catch (error) {
      return fail(err.internal(messages.fieldUniqueIndexBuildFailed({ detail: (error as Error).message })));
    }
  }

  let txResult: Result<Field>;
  try {
    txResult = await sql
      .begin(async (tx): Promise<Result<Field>> => {
        await degradeForTableSchemaChange(existing.tableId, actorId, tx);
        const finalization = await requireFinalizationForIdConfig(tx, existing.tableId, existing.type, nextResult.data.config, locale);
        if (!finalization.ok) return finalization;
        const fieldResult = await persistFieldUpdate(id, nextResult.data, tx, locale);
        if (!fieldResult.ok) throw fieldResult;
        const field = fieldResult.data;
        if (field.type === "id") {
          await syncNumberSeriesFormat(
            tx,
            { kind: "field", id: field.id },
            numberSeriesFormatForField(field.config),
            (field.config as { assignment?: "creation" | "finalization" }).assignment ?? "creation",
          );
        }

        await logFieldUpdateDiff(existing, nextResult.data, actorId, tx);

        if (existing.name !== field.name) {
          await rewriteFieldNameReferences({ tableId: existing.tableId, oldName: existing.name, newName: field.name }, tx);
        }

        return ok(field);
      })
      .catch((e: unknown) => {
        if (typeof e === "object" && e !== null && "ok" in e && (e as { ok?: unknown }).ok === false) {
          return e as Result<Field>;
        }
        const conflict = namedResourceConflict<Field>(e, "idx_grids_fields_live_name", messages.fieldNameUnique);
        if (conflict) return conflict;
        return fail(err.internal(messages.fieldUpdateFailed({ detail: (e as Error).message })));
      });
  } catch (error) {
    if (uniqueIndexEnabled) {
      const cleanup = await cleanupPreparedUniqueIndex(id);
      if (!cleanup.ok) throw new AggregateError([error, cleanup.error], cleanup.error.message);
    }
    throw error;
  }
  if (!txResult.ok) {
    if (uniqueIndexEnabled) {
      const cleanup = await cleanupPreparedUniqueIndex(id);
      if (!cleanup.ok) return fail(cleanup.error);
    }
    return txResult;
  }
  const field = txResult.data;

  const synchronizedField = await syncFieldIndexes(existing, field, actorId, locale);
  if (!synchronizedField.ok) return synchronizedField;

  await emitTableMetadataEvent(existing.tableId, {
    type: "field.updated",
    resource: { kind: "field", id: synchronizedField.data.id, tableId: existing.tableId },
    actorId,
  });
  await refreshForTableSchemaChange(existing.tableId, actorId);
  return synchronizedField;
};

/**
 * Reorders the live fields of a table to match the given id sequence.
 * Skips ids that don't belong to `tableId` (defensive — stops a malicious
 * client from reshuffling another user's table by mixing ids). Writes
 * positions in ONE round-trip via UNNEST + a CASE-driven UPDATE so the
 * change is atomic and the wire cost is constant in the field count.
 */
export const reorder = async (tableId: string, fieldIds: string[], actorId: string | null, locale?: string): Promise<Result<void>> => {
  if (fieldIds.length === 0) return ok();

  const [parentTable] = await sql<{ kind: string }[]>`
    SELECT kind FROM grids.tables WHERE id = ${tableId}::uuid AND deleted_at IS NULL
  `;
  if (!parentTable) return fail(err.notFound(getGridsCrudMessages(locale).table));

  // Filter to ids that actually belong to this table — protects against
  // the client passing an id from another (e.g. recently-renamed) table.
  const owned = await sql<{ id: string }[]>`
    SELECT id::text AS id FROM grids.fields
    WHERE table_id = ${tableId}::uuid AND deleted_at IS NULL
  `;
  const ownedIds = new Set(owned.map((r) => r.id));
  const validOrdered = fieldIds.filter((id) => ownedIds.has(id));
  if (validOrdered.length === 0) return ok();

  // Single-statement reorder via VALUES (id, position). Combined-table field
  // order is part of the canonical schema, so invalidate its active revision
  // in the same transaction before publishing the new order.
  const positions = `{${validOrdered.map((_, i) => i).join(",")}}`;
  const ids = toPgUuidArray(validOrdered);
  await sql.begin(async (tx) => {
    if (parentTable.kind === "federated") await degradeForTableSchemaChange(tableId, actorId, tx);
    await tx`
      UPDATE grids.fields AS f
      SET position = u.position, updated_at = now()
      FROM unnest(${ids}::uuid[], ${positions}::int[]) AS u(id, position)
      WHERE f.id = u.id AND f.table_id = ${tableId}::uuid
    `;
    await logAudit(
      {
        tableId,
        userId: actorId,
        action: "updated",
        diff: { fieldOrder: { old: null, new: validOrdered } },
      },
      tx,
    );
  });
  await emitTableMetadataEvent(tableId, {
    type: "field.reordered",
    resource: { kind: "field", id: tableId, tableId },
    actorId,
  });
  if (parentTable.kind === "federated") await refreshForTableSchemaChange(tableId, actorId);

  return ok();
};

/**
 * Reverses a soft-delete. The field row is un-trashed but already-
 * stripped form/view references are NOT auto-restored — those would
 * need manual re-add since their context could have moved on. Useful
 * when the user accidentally deletes a field they want back; rare
 * enough that the form/view re-add cost is acceptable.
 */
export const restore = async (id: string, actorId: string | null, locale?: string): Promise<Result<Field>> => {
  const messages = getGridsCrudMessages(locale);
  // get() now returns trashed rows but enforces the live-parent JOIN —
  // a field whose parent table or base is trashed resolves to null
  // here, which we surface as notFound (top-down restore: act on the
  // parent first).
  const existing = await get(id);
  if (!existing) return fail(err.notFound(messages.field));
  if (existing.deletedAt === null) return ok(existing);
  const [parentTable] = await sql<{ kind: string }[]>`
    SELECT kind FROM grids.tables WHERE id = ${existing.tableId}::uuid AND deleted_at IS NULL
  `;
  if (!parentTable) return fail(err.notFound(messages.table));
  const canonicalValidation = await validateCombinedCanonicalField(parentTable.kind, { ...existing, deletedAt: null }, locale);
  if (!canonicalValidation.ok) return canonicalValidation;
  const restoreUniqueIndex = existing.uniqueConstraint && isUniqueable(existing.type);
  if (restoreUniqueIndex) {
    try {
      await ensureFieldUniqueIndex(id, existing.type, existing.tableId);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return fail(err.conflict(messages.fieldRestoreValuesNotUnique));
      }
      return fail(err.internal(messages.fieldRestoreIndexFailed({ detail: (error as Error).message })));
    }
  }
  let restored: Result<Field>;
  try {
    restored = await sql.begin(async (tx): Promise<Result<Field>> => {
      await degradeForTableSchemaChange(existing.tableId, actorId, tx);
      const finalization = await requireFinalizationForIdConfig(tx, existing.tableId, existing.type, existing.config, locale);
      if (!finalization.ok) return finalization;
      const result = await writeNamedResource(
        () =>
          tx.savepoint(async (sp) => {
            const [row] = await sp<DbRow[]>`
              UPDATE grids.fields SET deleted_at = NULL, updated_at = now()
              WHERE id = ${id}::uuid
              RETURNING *
            `;
            if (!row) throw new Error("restore failed");
            if (existing.type === "id") await setNumberSeriesArchived(sp, { kind: "field", id }, false);
            return mapFieldRow(row);
          }),
        "idx_grids_fields_live_name",
        messages.fieldNameUnique,
      );
      if (!result.ok) return result;
      await logAudit({ tableId: existing.tableId, userId: actorId, action: "restored" }, tx);
      return result;
    });
  } catch (error) {
    if (restoreUniqueIndex) await dropFieldUniqueIndex(id);
    throw error;
  }
  if (!restored.ok) {
    if (restoreUniqueIndex) await dropFieldUniqueIndex(id);
    return restored;
  }
  await emitTableMetadataEvent(existing.tableId, {
    type: "field.restored",
    resource: { kind: "field", id, tableId: existing.tableId },
    actorId,
  });
  // Re-create the expression index if the field was indexed.
  if (existing.indexed) void ensureFieldIndex(id, existing.type, existing.tableId, existing.config);
  await refreshForTableSchemaChange(existing.tableId, actorId);
  return ok({ ...existing, deletedAt: null });
};

export const softDelete = async (id: string, actorId: string | null, locale?: string): Promise<Result<void>> => {
  const messages = getGridsCrudMessages(locale);
  const existing = await get(id);
  if (!existing || existing.deletedAt) return fail(err.notFound(messages.field));

  const deleted = await sql.begin(async (tx): Promise<Result<void>> => {
    // Keep the same lock order as Combined-table publication: schema lock,
    // then table/revision rows. This prevents publish/delete deadlocks and
    // makes the dependent scan stable for the complete mutation.
    await lockFederatedSchemaTables([existing.tableId], tx);
    // Serialize policy edits and field deletion through the parent table.
    // This keeps selected-field audit requirements valid under concurrent
    // admin requests.
    const [table] = await tx<{ id: string; kind: string; columns: unknown; display_config: unknown }[]>`
      SELECT id::text AS id, kind, columns, display_config
      FROM grids.tables
      WHERE id = ${existing.tableId}::uuid AND deleted_at IS NULL
      FOR UPDATE
    `;
    if (!table) return fail(err.notFound(messages.table));

    const blockers = (await getFieldDependents(id, tx)).filter((dependent) => dependent.blocking);
    if (hasBlockingDependents(blockers)) {
      return fail(err.conflict(messages.fieldStillUsed({ resources: blockers.map((dependent) => dependent.resourceName).join(", ") })));
    }

    await degradeForTableSchemaChange(existing.tableId, actorId, tx);
    const [deleted] = await tx<DbRow[]>`
      UPDATE grids.fields SET deleted_at = now(), updated_at = now()
      WHERE id = ${id}::uuid AND deleted_at IS NULL
      RETURNING id
    `;
    if (!deleted) throw err.notFound(messages.field);
    if (existing.type === "id") await setNumberSeriesArchived(tx, { kind: "field", id }, true);
    await logAudit({ tableId: existing.tableId, userId: actorId, action: "deleted" }, tx);
    // Auto-cleanup: strip the soft-deleted field id from every form's
    // config.fields[] in the same table. Views/forms see a stripped column
    // immediately rather than rendering a stale reference.
    await tx`
      UPDATE grids.forms
      SET config = jsonb_set(
        config,
        '{fields}',
        COALESCE(
          (
            SELECT jsonb_agg(elem)
            FROM jsonb_array_elements(config->'fields') AS elem
            WHERE elem->>'fieldId' <> ${id}
          ),
          '[]'::jsonb
        )
      )
      WHERE table_id = ${existing.tableId}::uuid
        AND config->'fields' @> jsonb_build_array(jsonb_build_object('fieldId', ${id}::text))
    `;
    const columns = FieldColumnSpecSchema.array().safeParse(table.columns ?? []);
    if (columns.success) {
      await tx`
        UPDATE grids.tables
        SET columns = ${columns.data.filter((column) => column.fieldId !== id)}::jsonb,
            display_config = ${withoutFieldDisplayReference(table.display_config, id)}::jsonb,
            updated_at = now()
        WHERE id = ${existing.tableId}::uuid
      `;
    }
    const viewRows = await tx<{ id: string; ui: unknown }[]>`
      SELECT id::text AS id, ui
      FROM grids.views
      WHERE table_id = ${existing.tableId}::uuid AND deleted_at IS NULL
      FOR UPDATE
    `;
    for (const view of viewRows) {
      await tx`
        UPDATE grids.views
        SET ui = ${withoutFieldViewUiReference(view.ui, id)}::jsonb,
            updated_at = now()
        WHERE id = ${view.id}::uuid
      `;
    }
    return ok();
  });
  if (!deleted.ok) return deleted;

  // Drop any expression index since the field is gone.
  if (existing.indexed) void dropFieldIndex(id);
  if (existing.uniqueConstraint) await dropFieldUniqueIndex(id);
  await emitTableMetadataEvent(existing.tableId, {
    type: "field.deleted",
    resource: { kind: "field", id, tableId: existing.tableId },
    actorId,
  });
  await refreshForTableSchemaChange(existing.tableId, actorId);
  return ok();
};

export { get, getByShortId, getByShortIdForTable, listByTable, listByTables, listTrashedByBase } from "./field-read";

export { materializeFieldDefault, validateDefaultValue };
