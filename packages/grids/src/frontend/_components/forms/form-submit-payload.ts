import type { PublicField as Field } from "../../../api/public-dto";
import { sanitizeFieldValues } from "../fields/field-render";

export type InlineCreateDraft = {
  tempId: string;
  data: Record<string, unknown>;
  existing?: { id: string; version: number };
};

export type InlineCreateState = Record<string, InlineCreateDraft[]>;
export type FormEditState = { version: number; values: Record<string, unknown>; inlineCreates: InlineCreateState };

export const buildFormSubmitPayload = (
  fields: Field[],
  values: Record<string, unknown>,
  inlineCreates: InlineCreateState = {},
  options: { omitEmpty?: boolean; idempotencyKey?: string; recordVersion?: number } = { omitEmpty: true },
): Record<string, unknown> => {
  const data = sanitizeFieldValues(fields, values, { omitEmpty: options.omitEmpty ?? true });
  const cleanInlineCreates = Object.fromEntries(
    Object.entries(inlineCreates)
      .map(([fieldId, drafts]) => [
        fieldId,
        drafts
          .map((draft) => ({
            tempId: draft.tempId,
            ...(draft.existing ? { existing: draft.existing } : {}),
            data: Object.fromEntries(
              Object.entries(draft.data).filter(([, value]) => {
                if (draft.existing) return value !== undefined;
                if (value === "" || value === undefined || value === null) return false;
                if (Array.isArray(value) && value.length === 0) return false;
                return true;
              }),
            ),
          }))
          .filter((draft) => draft.existing || Object.keys(draft.data).length > 0),
      ])
      .filter(([, drafts]) => (drafts as InlineCreateDraft[]).length > 0),
  ) as InlineCreateState;
  for (const [fieldId] of Object.entries(inlineCreates)) {
    if (options.recordVersion !== undefined && Array.isArray(values[fieldId]) && values[fieldId].length === 0) data[fieldId] = [];
    const allowedTempIds = new Set((cleanInlineCreates[fieldId] ?? []).map((draft) => draft.tempId));
    const value = data[fieldId];
    if (Array.isArray(value)) {
      const cleaned = value.filter((id) => typeof id !== "string" || !id.startsWith("tmp_") || allowedTempIds.has(id));
      if (cleaned.length > 0) data[fieldId] = cleaned;
      else if (options.recordVersion !== undefined) data[fieldId] = [];
      else delete data[fieldId];
    } else if (typeof value === "string" && value.startsWith("tmp_") && !allowedTempIds.has(value)) {
      delete data[fieldId];
    }
  }
  if (options.recordVersion !== undefined) {
    const updates = Object.fromEntries(
      Object.entries(cleanInlineCreates).map(([fieldId, drafts]) => [
        fieldId,
        drafts.flatMap((draft) =>
          draft.existing ? [{ recordId: draft.existing.id, version: draft.existing.version, data: draft.data }] : [],
        ),
      ]),
    );
    for (const [fieldId, drafts] of Object.entries(cleanInlineCreates)) {
      const ids = new Map(drafts.flatMap((draft) => (draft.existing ? [[draft.tempId, draft.existing.id] as const] : [])));
      if (Array.isArray(data[fieldId])) data[fieldId] = data[fieldId].map((id) => (typeof id === "string" ? (ids.get(id) ?? id) : id));
    }
    return {
      data,
      version: options.recordVersion,
      idempotencyKey: options.idempotencyKey,
      inlineUpdates: updates,
      inlineCreates: Object.fromEntries(
        Object.entries(cleanInlineCreates).map(([fieldId, drafts]) => [fieldId, drafts.filter((draft) => !draft.existing)]),
      ),
    };
  }
  if (options.idempotencyKey) return { data, inlineCreates: cleanInlineCreates, idempotencyKey: options.idempotencyKey };
  return Object.keys(cleanInlineCreates).length > 0 ? { data, inlineCreates: cleanInlineCreates } : data;
};
