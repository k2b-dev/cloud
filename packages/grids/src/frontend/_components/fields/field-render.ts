import type { PublicField as Field } from "../../../api/public-dto";
import { ObjectListConfigSchema, objectListInputValue } from "../../../field-types/object-list";

const SYSTEM_OR_COMPUTED_FIELD_TYPES = new Set([
  "id",
  "formula",
  "lookup",
  "rollup",
  "html_template",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
]);

const USER_EDITABLE_FIELD_TYPES = new Set([
  "text",
  "longtext",
  "number",
  "boolean",
  "date",
  "select",
  "percent",
  "duration",
  "json",
  "object_list",
  "principal",
]);
export const RECORD_INPUT_FIELD_TYPES = new Set([...USER_EDITABLE_FIELD_TYPES, "relation"]);

const isSystemOrComputedField = (type: string): boolean => SYSTEM_OR_COMPUTED_FIELD_TYPES.has(type);
export const isUserEditable = (type: string): boolean => USER_EDITABLE_FIELD_TYPES.has(type);
export const isRecordInputField = (type: string): boolean => RECORD_INPUT_FIELD_TYPES.has(type) && !isSystemOrComputedField(type);

const isNowDefault = (value: unknown): boolean =>
  typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "now";

const isEmptyValue = (value: unknown): boolean =>
  value === "" || value === undefined || value === null || (Array.isArray(value) && value.length === 0);

const stringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return typeof value === "string" && value.length > 0 ? [value] : [];
};

export const initialFieldInputValue = (field: Field, current?: unknown): unknown => {
  if (field.type === "object_list") {
    const value = current !== undefined ? current : (field.defaultValue ?? null);
    const config = ObjectListConfigSchema.safeParse(field.config);
    return config.success ? objectListInputValue(value, config.data) : value;
  }
  if (current !== undefined && current !== null) {
    if (field.type === "relation" || field.type === "select") return stringArray(current);
    if (field.type === "principal") return Array.isArray(current) ? current : [];
    return current;
  }
  if (field.type === "relation" || field.type === "select" || field.type === "principal") return [];
  if (field.type === "boolean") return false;
  if (field.type === "date" && isNowDefault(field.defaultValue)) return "";
  return field.defaultValue !== null && field.defaultValue !== undefined ? field.defaultValue : "";
};

const sanitizeFieldValue = (field: Field, raw: unknown): unknown => {
  if (field.type === "relation") return stringArray(raw);
  if (field.type === "select") {
    const values = stringArray(raw);
    const multiple = Boolean((field.config as { multiple?: boolean }).multiple);
    return multiple ? values : values.slice(0, 1);
  }
  if (field.type === "principal") return Array.isArray(raw) ? raw : [];
  return raw;
};

export const sanitizeFieldValues = (
  fields: Field[],
  values: Record<string, unknown>,
  options: { omitEmpty?: boolean } = {},
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = sanitizeFieldValue(field, values[field.id]);
    // An explicitly emptied list is distinct from an absent value/default.
    if (field.type === "object_list" && Array.isArray(value)) {
      out[field.id] = value;
      continue;
    }
    if (isEmptyValue(value)) {
      if (!options.omitEmpty) out[field.id] = null;
      continue;
    }
    out[field.id] = value;
  }
  return out;
};
