import { isRecordWritableFieldType } from "../field-types";
import { getGridsCrudMessages } from "./crud-messages";
import { parseJsonbRow } from "./jsonb";
import type { Field, GridRecord } from "./types";

type DbRecordRow = Record<string, unknown>;

/** The JSON read path uses the same captured dependencies as SQL projections.
 * In particular, an omitted live lookup projection must not expose raw capture data. */
export const applyFinalizedComputedAccess = (
  rows: DbRecordRow[],
  recordsById: ReadonlyMap<string, Pick<GridRecord, "data" | "fieldErrors">>,
  authorizedTableIds: ReadonlySet<string> | undefined,
  fields: Field[],
  locale?: string,
): void => {
  const computed = fields.filter((field) => !field.deletedAt && ["formula", "lookup", "rollup", "object_list"].includes(field.type));
  for (const row of rows) {
    if (!row.finalized_at || typeof row.id !== "string") continue;
    const record = recordsById.get(row.id);
    if (!record) continue;
    const types = parseJsonbRow<Record<string, unknown>>(row.finalized_computed_types, {});
    const stored = parseJsonbRow<Record<string, unknown>>(row.data, {});
    for (const field of computed) {
      if (Object.hasOwn(types, field.id) && Object.hasOwn(stored, field.id)) continue;
      record.data[field.id] = null;
      record.fieldErrors ??= {};
      record.fieldErrors[field.id] = getGridsCrudMessages(locale).missingCapturedCalculation;
    }
    if (authorizedTableIds === undefined) continue;
    const dependencies = parseJsonbRow<Record<string, unknown>>(row.finalized_computed_dependencies, {});
    for (const fieldId of Object.keys(types)) {
      const required = dependencies[fieldId];
      if (!Array.isArray(required) || !required.every((id) => typeof id === "string" && authorizedTableIds.has(id))) {
        record.data[fieldId] = null;
      }
    }
  }
};

export const mapRecordRow = (row: DbRecordRow): GridRecord => ({
  id: row.id as string,
  shortId: row.short_id as string,
  tableId: row.table_id as string,
  data: parseJsonbRow<Record<string, unknown>>(row.data, {}),
  version: row.version as number,
  finalizedAt: row.finalized_at ? (row.finalized_at as Date).toISOString() : null,
  finalizedBy: (row.finalized_by as string | null) ?? null,
  finalRevisionId: (row.final_revision_id as string | null) ?? null,
  deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
  createdBy: (row.created_by as string | null) ?? null,
  updatedBy: (row.updated_by as string | null) ?? null,
  createdAt: (row.created_at as Date).toISOString(),
  updatedAt: (row.updated_at as Date).toISOString(),
});

export const splitRelationsFromData = (
  data: Record<string, unknown>,
  fields: Field[],
): { data: Record<string, unknown>; relations: Map<string, string[]> } => {
  const relationFieldIds = new Set(fields.filter((field) => field.type === "relation" && !field.deletedAt).map((field) => field.id));
  const persistableData: Record<string, unknown> = {};
  const relations = new Map<string, string[]>();

  for (const [fieldId, value] of Object.entries(data)) {
    if (!relationFieldIds.has(fieldId)) {
      persistableData[fieldId] = value;
      continue;
    }

    const ids = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : typeof value === "string"
        ? [value]
        : [];
    relations.set(fieldId, ids);
  }

  return { data: persistableData, relations };
};

export const buildPersistedUpdateData = (
  existingData: Record<string, unknown>,
  validatedData: Record<string, unknown>,
  fields: Field[],
): Record<string, unknown> => {
  const persistableFieldIds = new Set(
    fields
      .filter((field) => (isRecordWritableFieldType(field.type) && field.type !== "relation") || field.type === "id")
      .map((field) => field.id),
  );
  const merged = {
    ...Object.fromEntries(Object.entries(existingData).filter(([fieldId]) => persistableFieldIds.has(fieldId))),
    ...validatedData,
  };

  for (const [fieldId, value] of Object.entries(merged)) {
    if (value === null) delete merged[fieldId];
  }
  return merged;
};

export const buildRecordDiff = (
  existingData: Record<string, unknown>,
  validatedData: Record<string, unknown>,
): Record<string, { old: unknown; new: unknown }> => {
  const diff: Record<string, { old: unknown; new: unknown }> = {};
  for (const [fieldId, value] of Object.entries(validatedData)) {
    const oldValue = existingData[fieldId] ?? null;
    const newValue = value ?? null;
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      diff[fieldId] = { old: oldValue, new: newValue };
    }
  }
  return diff;
};
