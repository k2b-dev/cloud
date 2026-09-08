import { createHash } from "node:crypto";
import type { FormConfig } from "../service/forms";
import { stableCustomAppValue } from "./stable-value";

type CustomAppFormCapabilityField = {
  id: string;
  type: string;
  config: unknown;
  deletedAt: string | null;
};

export type CustomAppFormSecurityField = CustomAppFormCapabilityField & {
  tableId: string;
  required: boolean;
  defaultValue: unknown;
};

type CustomAppFormInlineTargetReference = { tableId: string; fieldId: string };

export const customAppFormFieldHash = (fieldIds: readonly string[], fields: readonly CustomAppFormCapabilityField[]): string => {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const snapshots = [...new Set(fieldIds)].sort().map((fieldId) => {
    const field = fieldsById.get(fieldId);
    return field
      ? { id: field.id, type: field.type, config: stableCustomAppValue(field.config), deleted: field.deletedAt !== null }
      : { id: fieldId, missing: true };
  });
  return createHash("sha256").update("grids.custom-app.form-fields.v1\0").update(JSON.stringify(snapshots)).digest("hex");
};

export const customAppFormInlineTargetReferences = (
  config: FormConfig,
  directFields: readonly CustomAppFormCapabilityField[],
): CustomAppFormInlineTargetReference[] => {
  const directFieldsById = new Map(directFields.map((field) => [field.id, field]));
  const references = config.fields.flatMap((entry) => {
    if (entry.kind !== "user_input" || !entry.inlineCreate?.enabled) return [];
    const relationField = directFieldsById.get(entry.fieldId);
    const targetTableId =
      relationField?.type === "relation" && relationField.config && typeof relationField.config === "object"
        ? (relationField.config as { targetTableId?: unknown }).targetTableId
        : null;
    if (typeof targetTableId !== "string") return [];
    return (entry.inlineCreate.fields ?? []).map((field) => ({ tableId: targetTableId, fieldId: field.fieldId }));
  });
  return references.sort((left, right) => {
    const leftKey = `${left.tableId}\0${left.fieldId}`;
    const rightKey = `${right.tableId}\0${right.fieldId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
};

export const customAppFormInlineTargetTableIds = (config: FormConfig, directFields: readonly CustomAppFormCapabilityField[]): string[] =>
  [...new Set(customAppFormInlineTargetReferences(config, directFields).map((reference) => reference.tableId))].sort();

const configuredDefault = (value: unknown): unknown => (value === undefined || value === null ? null : stableCustomAppValue(value));

export const customAppFormSecurityHash = (input: {
  tableId: string;
  config: FormConfig;
  fields: readonly CustomAppFormSecurityField[];
}): string => {
  const directFields = input.fields.filter((field) => field.tableId === input.tableId);
  const inlineReferences = customAppFormInlineTargetReferences(input.config, directFields);
  const fieldReferences = [
    ...input.config.fields.map((entry) => ({ tableId: input.tableId, fieldId: entry.fieldId })),
    ...inlineReferences,
  ];
  const fieldsByKey = new Map(input.fields.map((field) => [`${field.tableId}\0${field.id}`, field]));
  const fieldSnapshots = [
    ...new Map(fieldReferences.map((reference) => [`${reference.tableId}\0${reference.fieldId}`, reference])).values(),
  ]
    .sort((left, right) => {
      const leftKey = `${left.tableId}\0${left.fieldId}`;
      const rightKey = `${right.tableId}\0${right.fieldId}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    })
    .map((reference) => {
      const field = fieldsByKey.get(`${reference.tableId}\0${reference.fieldId}`);
      return field
        ? {
            tableId: field.tableId,
            id: field.id,
            type: field.type,
            config: stableCustomAppValue(field.config),
            required: field.required,
            defaultValue: configuredDefault(field.defaultValue),
            deleted: field.deletedAt !== null,
          }
        : { tableId: reference.tableId, id: reference.fieldId, missing: true };
    });
  const fieldsConfig = input.config.fields
    .map((entry) =>
      entry.kind === "form_value"
        ? { kind: entry.kind, fieldId: entry.fieldId, value: stableCustomAppValue(entry.value) }
        : {
            kind: entry.kind,
            fieldId: entry.fieldId,
            required: entry.required === true,
            defaultValue: configuredDefault(entry.defaultValue),
            inlineCreate: entry.inlineCreate?.enabled
              ? {
                  enabled: true,
                  fields: [...(entry.inlineCreate.fields ?? [])]
                    .sort((left, right) => (left.fieldId < right.fieldId ? -1 : left.fieldId > right.fieldId ? 1 : 0))
                    .map((field) => ({
                      fieldId: field.fieldId,
                      required: field.required === true,
                      defaultValue: configuredDefault(field.defaultValue),
                    })),
                }
              : null,
          },
    )
    .sort((left, right) => (left.fieldId < right.fieldId ? -1 : left.fieldId > right.fieldId ? 1 : 0));
  const validations = [...(input.config.validations ?? [])].sort((left, right) => {
    const leftKey = `${left.leftFieldId}\0${left.operator}\0${left.rightFieldId}\0${left.errorFieldId ?? ""}\0${left.message}`;
    const rightKey = `${right.leftFieldId}\0${right.operator}\0${right.rightFieldId}\0${right.errorFieldId ?? ""}\0${right.message}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return createHash("sha256")
    .update("grids.custom-app.form-security.v1\0")
    .update(JSON.stringify({ config: { fields: fieldsConfig, validations }, fields: fieldSnapshots }))
    .digest("hex");
};
