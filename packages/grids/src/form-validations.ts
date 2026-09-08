import Decimal from "decimal.js";
import type { FormValidationRule } from "./contracts";
import { getRecordWritableFieldType } from "./field-types";
import type { Field } from "./service/types";

type FormValidationFailure = FormValidationRule & { errorFieldId: string };

type ComparableKind = "number" | "percent" | "duration" | "date" | "dateTime";

export const formValidationComparableKind = (field: Pick<Field, "type" | "config">): ComparableKind | null => {
  if (field.type === "number" || field.type === "percent" || field.type === "duration") return field.type;
  if (field.type !== "date") return null;
  return (field.config as { includeTime?: boolean }).includeTime ? "dateTime" : "date";
};

export const formValidationFieldsCompatible = (left: Pick<Field, "type" | "config">, right: Pick<Field, "type" | "config">): boolean => {
  const leftKind = formValidationComparableKind(left);
  return leftKind !== null && leftKind === formValidationComparableKind(right);
};

type ComparableValue = Decimal | string;

const decimalValue = (value: unknown): Decimal | null => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
};

const comparableValue = (kind: ComparableKind, value: unknown): ComparableValue | null => {
  if (kind === "number" || kind === "percent" || kind === "duration") return decimalValue(value);
  if (typeof value !== "string" || value.length === 0) return null;
  if (kind === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Decimal(timestamp) : null;
};

const compare = (left: ComparableValue, operator: FormValidationRule["operator"], right: ComparableValue): boolean => {
  if (left instanceof Decimal && right instanceof Decimal) {
    switch (operator) {
      case "eq":
        return left.eq(right);
      case "neq":
        return !left.eq(right);
      case "lt":
        return left.lt(right);
      case "lte":
        return left.lte(right);
      case "gt":
        return left.gt(right);
      case "gte":
        return left.gte(right);
    }
  }
  if (typeof left !== "string" || typeof right !== "string") return false;
  switch (operator) {
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
  }
};

/** Evaluates already-normalized Form values. Empty values stay owned by required/type validation. */
export const evaluateFormValidations = (
  rules: readonly FormValidationRule[] | undefined,
  values: Readonly<Record<string, unknown>>,
  fieldsById: ReadonlyMap<string, Pick<Field, "id" | "type" | "config">>,
): FormValidationFailure[] =>
  (rules ?? []).flatMap((rule) => {
    const leftField = fieldsById.get(rule.leftFieldId);
    const rightField = fieldsById.get(rule.rightFieldId);
    if (!leftField || !rightField) return [];
    const kind = formValidationComparableKind(leftField);
    if (!kind || kind !== formValidationComparableKind(rightField)) return [];
    const leftNormalized = getRecordWritableFieldType(leftField.type)?.validate(values[rule.leftFieldId], leftField.config, false);
    const rightNormalized = getRecordWritableFieldType(rightField.type)?.validate(values[rule.rightFieldId], rightField.config, false);
    if (!leftNormalized?.ok || !rightNormalized?.ok) return [];
    const left = comparableValue(kind, leftNormalized.value);
    const right = comparableValue(kind, rightNormalized.value);
    if (left === null || right === null || compare(left, rule.operator, right)) return [];
    return [{ ...rule, errorFieldId: rule.errorFieldId ?? rule.leftFieldId }];
  });
