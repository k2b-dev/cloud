import { err, fail, ok, type Result } from "@k2b/stdlib";
import { FormConfigSchema } from "../contracts";
import { isRecordWritableFieldType } from "../field-types";
import { formValidationFieldsCompatible } from "../form-validations";
import { listByTable as listFields, validateDefaultValue } from "./fields";
import { formMessagesFor } from "./form-messages";
import type { FormConfig, FormFieldEntry } from "./forms";
import type { Field } from "./types";

type UserInputEntry = Extract<FormFieldEntry, { kind: "user_input" }>;
type InlineCreateConfig = NonNullable<UserInputEntry["inlineCreate"]>;
type InlineCreateField = NonNullable<InlineCreateConfig["fields"]>[number];

const normalizeConfiguredValue = (field: Field, entry: FormFieldEntry, locale?: string): Result<FormFieldEntry> => {
  const t = formMessagesFor(locale);
  const raw = entry.kind === "form_value" ? entry.value : entry.defaultValue;
  const validated = validateDefaultValue(field.type, field.config, raw, locale);
  if (!validated.ok) return fail(err.badInput(t.invalidFormValue({ field: field.name, detail: validated.error.message })));
  if (entry.kind === "form_value") return ok({ ...entry, value: validated.data });
  return ok(entry.defaultValue !== undefined ? { ...entry, defaultValue: validated.data } : entry);
};

const normalizeInlineFields = async (
  parentField: Field,
  fields: InlineCreateField[],
  locale?: string,
): Promise<Result<InlineCreateField[]>> => {
  const t = formMessagesFor(locale);
  const targetTableId = (parentField.config as { targetTableId?: unknown }).targetTableId;
  if (typeof targetTableId !== "string") {
    return fail(err.badInput(t.inlineNeedsTarget({ field: parentField.name })));
  }
  if (fields.length === 0) {
    return fail(err.badInput(t.inlineNeedsField({ field: parentField.name })));
  }

  const targetFields = await listFields(targetTableId);
  const targetById = new Map(targetFields.filter((field) => !field.deletedAt).map((field) => [field.id, field]));
  const seen = new Set<string>();
  const normalized: InlineCreateField[] = [];
  for (const entry of fields) {
    const targetField = targetById.get(entry.fieldId);
    if (!targetField) return fail(err.badInput(t.inlineUnknownField({ field: parentField.name })));
    if (seen.has(entry.fieldId)) {
      return fail(err.badInput(t.inlineDuplicateField({ field: parentField.name, target: targetField.name })));
    }
    seen.add(entry.fieldId);
    if (!isRecordWritableFieldType(targetField.type) || targetField.type === "relation") {
      return fail(err.badInput(t.inlineCannotEdit({ field: parentField.name, target: targetField.name })));
    }
    const defaultValue = validateDefaultValue(targetField.type, targetField.config, entry.defaultValue, locale);
    if (!defaultValue.ok) {
      return fail(err.badInput(t.invalidInlineValue({ field: targetField.name, detail: defaultValue.error.message })));
    }
    normalized.push(entry.defaultValue !== undefined ? { ...entry, defaultValue: defaultValue.data } : entry);
  }
  return ok(normalized);
};

const normalizeInlineCreate = async (field: Field, entry: UserInputEntry, locale?: string): Promise<Result<UserInputEntry>> => {
  const t = formMessagesFor(locale);
  if (!entry.inlineCreate?.enabled) {
    return ok(entry.inlineCreate ? { ...entry, inlineCreate: undefined } : entry);
  }
  if (field.type !== "relation") {
    return fail(err.badInput(t.inlineRequiresRelation({ field: field.name })));
  }
  const fields = await normalizeInlineFields(field, entry.inlineCreate.fields ?? [], locale);
  if (!fields.ok) return fields;
  return ok({ ...entry, inlineCreate: { enabled: true, fields: fields.data } });
};

export const validateFormConfig = async (tableId: string, config: unknown, locale?: string): Promise<Result<FormConfig>> => {
  const t = formMessagesFor(locale);
  const parsed = FormConfigSchema.safeParse(config);
  if (!parsed.success) {
    return fail(err.badInput(t.invalidConfig));
  }

  const fields = await listFields(tableId);
  const byId = new Map(fields.filter((field) => !field.deletedAt).map((field) => [field.id, field]));
  const seen = new Set<string>();
  const normalizedFields: FormFieldEntry[] = [];
  for (const entry of parsed.data.fields as FormFieldEntry[]) {
    const field = byId.get(entry.fieldId);
    if (!field) return fail(err.badInput(t.unknownConfigField));
    if (seen.has(entry.fieldId)) return fail(err.badInput(t.duplicateConfigField({ field: field.name })));
    seen.add(entry.fieldId);
    if (!isRecordWritableFieldType(field.type)) return fail(err.badInput(t.configFieldUnsupported({ field: field.name })));

    const configuredValue = normalizeConfiguredValue(field, entry, locale);
    if (!configuredValue.ok) return configuredValue;
    if (configuredValue.data.kind !== "user_input") {
      normalizedFields.push(configuredValue.data);
      continue;
    }
    const inlineCreate = await normalizeInlineCreate(field, configuredValue.data, locale);
    if (!inlineCreate.ok) return inlineCreate;
    normalizedFields.push(inlineCreate.data);
  }

  const userInputIds = new Set(normalizedFields.filter((entry) => entry.kind === "user_input").map((entry) => entry.fieldId));
  for (const rule of parsed.data.validations ?? []) {
    const left = byId.get(rule.leftFieldId);
    const right = byId.get(rule.rightFieldId);
    if (!left || !right || !userInputIds.has(left.id) || !userInputIds.has(right.id)) {
      return fail(err.badInput(t.validationFieldsVisible));
    }
    if (left.id === right.id) return fail(err.badInput(t.validationFieldsDistinct));
    if (!formValidationFieldsCompatible(left, right)) {
      return fail(err.badInput(t.validationFieldsIncompatible({ left: left.name, right: right.name })));
    }
    if (rule.errorFieldId && rule.errorFieldId !== left.id && rule.errorFieldId !== right.id) {
      return fail(err.badInput(t.validationErrorField));
    }
  }

  return ok({ ...(parsed.data as FormConfig), fields: normalizedFields });
};
